import { randomUUID } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { processStudentPhoto } from "@/lib/images/photo";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { detectFileType } from "@/lib/storage/file-types";
import { discardUpload, prepareUpload, readStoredFile, recordUpload, retireStoredFile, type PreparedUpload } from "@/modules/files/files.service";
import { assertApplicationScope } from "./admissions.policy";
import { assertCanDo, type AdmissionStatus } from "./admissions.rules";
import type { DocumentUploadFields } from "./documents.schemas";

/**
 * Admission documents (design §5.2–5.3; KI-048). The StoredFile of each document is PRIVATE, encrypted
 * and owned by its StudentDocument row (ownerType "StudentDocument"), so it stays valid when approval later
 * links the document to the student.
 *
 * Upload order (CPU and storage work OUTSIDE the transaction, backend rule):
 *   authorize + scope → application pre-check → content-type detection → photo re-encode (sharp) →
 *   encrypted blob written (prepareUpload) → ONE short transaction: application row FOR UPDATE, status
 *   re-check, retire the previous photo, StoredFile row + StudentDocument row + audit → on any failure
 *   the blob is discarded. Audit entries carry ids, type, MIME type and size — never names or contents.
 */
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
export const DOCUMENT_OWNER_TYPE = "StudentDocument";

const purposeFor = (type: string) => (type === "PHOTO" ? ("student.photo" as const) : ("student.document" as const));

/** 32 hex characters: a valid StoredFile owner id, created before the row so the blob can name its owner. */
const newDocumentId = () => randomUUID().replace(/-/g, "");

async function lockApplicationStatus(tx: Tx, applicationId: string): Promise<AdmissionStatus> {
  const rows = await tx.$queryRaw<{ status: AdmissionStatus }[]>`SELECT status::text AS status FROM admission_application WHERE id = ${applicationId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Application not found.");
  return rows[0].status;
}

/** Upload one document (or the photo) to an undecided application. */
export async function addApplicationDocument(ctx: AuthContext, applicationId: string, fields: DocumentUploadFields, file: { bytes: Uint8Array; fileName: string }) {
  authorize(ctx, "student.document.manage");
  assertApplicationScope(authorize(ctx, "admission.read"));
  const app = await prisma.admissionApplication.findUnique({ where: { id: applicationId }, select: { status: true } });
  if (!app) throw new NotFoundError("Application not found.");
  assertCanDo("manageDocuments", app.status);

  let bytes = file.bytes;
  let fileName = file.fileName;
  if (fields.type === "PHOTO") {
    const detected = detectFileType(bytes);
    if (detected !== "image/jpeg" && detected !== "image/png") {
      throw new ValidationError("The photo must be a JPEG or PNG image.", [{ path: "file", message: "Use a JPEG or PNG photo." }]);
    }
    bytes = (await processStudentPhoto(bytes)).bytes; // throws → nothing stored (fail closed)
    fileName = "photo.jpg";
  }

  const documentId = newDocumentId();
  const prepared: PreparedUpload = await prepareUpload(ctx, purposeFor(fields.type), bytes, fileName, { type: DOCUMENT_OWNER_TYPE, id: documentId });
  try {
    return await prisma.$transaction(async (tx) => {
      assertCanDo("manageDocuments", await lockApplicationStatus(tx, applicationId));
      let replacedId: string | null = null;
      if (fields.type === "PHOTO") {
        const previous = await tx.studentDocument.findFirst({ where: { applicationId, type: "PHOTO", deletedAt: null }, select: { id: true, fileId: true } });
        if (previous) {
          await tx.studentDocument.update({ where: { id: previous.id }, data: { deletedAt: new Date() } });
          await retireStoredFile(tx, ctx, previous.fileId);
          replacedId = previous.id;
        }
      }
      const stored = await recordUpload(tx, ctx, prepared);
      await tx.studentDocument.create({ data: { id: documentId, applicationId, type: fields.type, label: fields.label, fileId: stored.id, uploadedById: ctx.userId } });
      await audit(tx, actorOf(ctx), {
        action: replacedId ? "document.replace" : "document.upload",
        entityType: "StudentDocument",
        entityId: documentId,
        after: { applicationId, type: fields.type, mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes, ...(replacedId ? { replacedDocumentId: replacedId } : {}) },
      });
      return { id: documentId, type: fields.type };
    });
  } catch (e) {
    await discardUpload(prepared); // storage and database stay consistent
    throw e;
  }
}

/** Current documents of an application (no file contents). */
export async function listApplicationDocuments(ctx: AuthContext, applicationId: string) {
  authorize(ctx, "student.document.read");
  assertApplicationScope(authorize(ctx, "admission.read"));
  return prisma.studentDocument.findMany({
    where: { applicationId, deletedAt: null },
    orderBy: [{ type: "asc" }, { createdAt: "asc" }],
    take: 50,
    select: {
      id: true,
      type: true,
      label: true,
      createdAt: true,
      verifiedAt: true,
      file: { select: { mimeType: true, sizeBytes: true, originalName: true } },
      uploadedBy: { select: { displayName: true } },
      verifiedBy: { select: { displayName: true } },
    },
  });
}

/**
 * Download: the application scope is checked here; the file layer then requires the purpose's read
 * permission and that the file belongs to exactly this document (owner-bound) — and audits the read.
 * Missing, other-application and forbidden documents all look like "not found".
 */
export async function readApplicationDocument(ctx: AuthContext, applicationId: string, documentId: string) {
  assertApplicationScope(authorize(ctx, "admission.read"));
  const doc = await prisma.studentDocument.findFirst({ where: { id: documentId, applicationId, deletedAt: null }, select: { id: true, type: true, fileId: true } });
  if (!doc) throw new NotFoundError("Document not found.");
  const file = await readStoredFile(ctx, doc.fileId, { purpose: purposeFor(doc.type), owner: { type: DOCUMENT_OWNER_TYPE, id: doc.id } });
  return { ...file, type: doc.type };
}

export async function removeApplicationDocument(ctx: AuthContext, applicationId: string, documentId: string) {
  authorize(ctx, "student.document.manage");
  assertApplicationScope(authorize(ctx, "admission.read"));
  await prisma.$transaction(async (tx) => {
    assertCanDo("manageDocuments", await lockApplicationStatus(tx, applicationId));
    const doc = await tx.studentDocument.findFirst({ where: { id: documentId, applicationId, deletedAt: null }, select: { id: true, type: true, fileId: true } });
    if (!doc) throw new NotFoundError("Document not found.");
    await tx.studentDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
    await retireStoredFile(tx, ctx, doc.fileId);
    await audit(tx, actorOf(ctx), { action: "document.remove", entityType: "StudentDocument", entityId: doc.id, before: { applicationId, type: doc.type } });
  });
}

/** Mark a document as checked against the original (who and when). */
export async function verifyApplicationDocument(ctx: AuthContext, applicationId: string, documentId: string) {
  authorize(ctx, "student.document.manage");
  assertApplicationScope(authorize(ctx, "admission.read"));
  await prisma.$transaction(async (tx) => {
    assertCanDo("manageDocuments", await lockApplicationStatus(tx, applicationId));
    const doc = await tx.studentDocument.findFirst({ where: { id: documentId, applicationId, deletedAt: null }, select: { id: true, type: true, verifiedAt: true } });
    if (!doc) throw new NotFoundError("Document not found.");
    if (doc.verifiedAt) throw new ConflictError("This document is already verified.");
    await tx.studentDocument.update({ where: { id: doc.id }, data: { verifiedAt: new Date(), verifiedById: ctx.userId } });
    await audit(tx, actorOf(ctx), { action: "document.verify", entityType: "StudentDocument", entityId: doc.id, after: { applicationId, type: doc.type } });
  });
}
