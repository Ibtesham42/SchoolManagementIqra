import { randomUUID } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { processStudentPhoto, stripDocumentImageMetadata } from "@/lib/images/photo";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { detectFileType } from "@/lib/storage/file-types";
import { discardUpload, prepareUpload, readStoredFile, recordUpload, retireStoredFile, type PreparedUpload } from "@/modules/files/files.service";
import { assertActorLinked, canReadPersonal, employeeReadAccess, employeeRecordAccess, isOwnRecord } from "./hr.policy";
import type { EmployeeDocumentFields } from "./hr.schemas";

/**
 * Staff documents and photo (Phase 3A M4b, owner decisions H5, H6, H8; S-15 lifecycle). Same design as the
 * Phase 2B admission documents: each StoredFile is PRIVATE, encrypted and owned by its EmployeeDocument row.
 *
 *   Upload: authorize (`employee.document.manage` + directory + personal tier) → employee pre-check → content
 *   detection → photo re-encode (sharp, metadata dropped) → encrypted blob (prepareUpload) — all OUTSIDE the
 *   transaction → ONE short transaction: employee FOR UPDATE, retire the previous photo, StoredFile row +
 *   EmployeeDocument row + audit → on any failure the blob is discarded.
 *   Read: the record check here (ALL, or SELF on the own record — documents need the personal tier, the photo is
 *   directory data), then the file layer's owner-bound check (purpose + exact owner + read permission) and audit.
 *   Missing, other-employee and forbidden documents all look like "not found".
 *   Removal/replacement retires the file; the S-15 job purges its blob after 30 days.
 * Audit entries carry ids, type, MIME type and size — never names or contents.
 * Documents stay manageable after an employee leaves (by design: relieving and experience letters are issued then).
 * Document images are re-saved without metadata (KI-068), like admission documents.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
export const EMPLOYEE_DOCUMENT_OWNER_TYPE = "EmployeeDocument";
const purposeFor = (type: string) => (type === "PHOTO" ? ("employee.photo" as const) : ("employee.document" as const));
/** 32 hex characters: a valid StoredFile owner id, created before the row so the blob can name its owner. */
const newDocumentId = () => randomUUID().replace(/-/g, "");

function authorizeManage(ctx: AuthContext) {
  authorize(ctx, "employee.document.manage");
  employeeReadAccess(ctx);
  if (!canReadPersonal(ctx)) throw new ForbiddenError("You need permission to view employees' personal details to manage their documents.");
}

async function lockEmployee(tx: Tx, employeeId: string) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Employee not found.");
}

const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

export async function addEmployeeDocument(ctx: AuthContext, employeeId: string, fields: EmployeeDocumentFields, file: { bytes: Uint8Array; fileName: string }) {
  authorizeManage(ctx);
  if (!(await prisma.employee.findFirst({ where: { id: employeeId, deletedAt: null }, select: { id: true } }))) throw new NotFoundError("Employee not found.");

  let bytes = file.bytes;
  let fileName = file.fileName;
  if (fields.type === "PHOTO") {
    const detected = detectFileType(bytes);
    if (detected !== "image/jpeg" && detected !== "image/png") throw new ValidationError("The photo must be a JPEG or PNG image.", [{ path: "file", message: "Use a JPEG or PNG photo." }]);
    bytes = (await processStudentPhoto(bytes)).bytes; // throws → nothing stored (fail closed)
    fileName = "photo.jpg";
  } else {
    // KI-068: document images are re-saved without metadata (e.g. GPS location of a phone scan); PDFs unchanged.
    const detected = detectFileType(bytes);
    if (detected === "image/jpeg" || detected === "image/png") bytes = await stripDocumentImageMetadata(bytes, detected);
  }

  const documentId = newDocumentId();
  const prepared: PreparedUpload = await prepareUpload(ctx, purposeFor(fields.type), bytes, fileName, { type: EMPLOYEE_DOCUMENT_OWNER_TYPE, id: documentId });
  try {
    return await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      let replacedId: string | null = null;
      if (fields.type === "PHOTO") {
        const previous = await tx.employeeDocument.findFirst({ where: { employeeId, type: "PHOTO", deletedAt: null }, select: { id: true, fileId: true } });
        if (previous) {
          await tx.employeeDocument.update({ where: { id: previous.id }, data: { deletedAt: new Date() } });
          await retireStoredFile(tx, ctx, previous.fileId);
          replacedId = previous.id;
        }
      }
      const stored = await recordUpload(tx, ctx, prepared);
      await tx.employeeDocument.create({ data: { id: documentId, employeeId, type: fields.type, label: fields.label, fileId: stored.id, uploadedById: ctx.userId } });
      await audit(tx, actorOf(ctx), {
        action: replacedId ? "employee_document.replace" : "employee_document.upload",
        entityType: "EmployeeDocument",
        entityId: documentId,
        after: { employeeId, type: fields.type, mimeType: prepared.mimeType, sizeBytes: prepared.sizeBytes, ...(replacedId ? { replacedDocumentId: replacedId } : {}) },
      });
      return { id: documentId, type: fields.type };
    });
  } catch (e) {
    await discardUpload(prepared); // storage and database stay consistent
    return busy(e);
  }
}

/** Current documents of one employee (no contents) — personal tier on that record (ALL, or own via SELF). */
export async function listEmployeeDocuments(ctx: AuthContext, employeeId: string) {
  const { tier } = employeeRecordAccess(ctx, employeeId);
  if (tier !== "personal") return null;
  return prisma.employeeDocument.findMany({
    where: { employeeId, deletedAt: null, employee: { deletedAt: null } },
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

/** Whether a current photo exists (for the profile header) — any record access. */
export async function hasEmployeePhoto(ctx: AuthContext, employeeId: string): Promise<boolean> {
  employeeRecordAccess(ctx, employeeId);
  return (await prisma.employeeDocument.count({ where: { employeeId, type: "PHOTO", deletedAt: null, employee: { deletedAt: null } } })) > 0;
}

export async function readEmployeeDocument(ctx: AuthContext, employeeId: string, documentId: string) {
  const { tier } = employeeRecordAccess(ctx, employeeId);
  if (tier !== "personal") throw new NotFoundError("Document not found.");
  const doc = await prisma.employeeDocument.findFirst({ where: { id: documentId, employeeId, deletedAt: null, type: { not: "PHOTO" }, employee: { deletedAt: null } }, select: { id: true, type: true, fileId: true } });
  if (!doc) throw new NotFoundError("Document not found.");
  return readStoredFile(ctx, doc.fileId, { purpose: purposeFor(doc.type), owner: { type: EMPLOYEE_DOCUMENT_OWNER_TYPE, id: doc.id } });
}

export async function readEmployeePhoto(ctx: AuthContext, employeeId: string) {
  employeeRecordAccess(ctx, employeeId);
  const doc = await prisma.employeeDocument.findFirst({ where: { employeeId, type: "PHOTO", deletedAt: null, employee: { deletedAt: null } }, select: { id: true, fileId: true } });
  if (!doc) throw new NotFoundError("Photo not found.");
  return readStoredFile(ctx, doc.fileId, { purpose: "employee.photo", owner: { type: EMPLOYEE_DOCUMENT_OWNER_TYPE, id: doc.id } });
}

export async function removeEmployeeDocument(ctx: AuthContext, employeeId: string, documentId: string) {
  authorizeManage(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const doc = await tx.employeeDocument.findFirst({ where: { id: documentId, employeeId, deletedAt: null }, select: { id: true, type: true, fileId: true } });
      if (!doc) throw new NotFoundError("Document not found.");
      await tx.employeeDocument.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });
      await retireStoredFile(tx, ctx, doc.fileId);
      await audit(tx, actorOf(ctx), { action: "employee_document.remove", entityType: "EmployeeDocument", entityId: doc.id, before: { employeeId, type: doc.type } });
    });
  } catch (e) {
    busy(e);
  }
}

/** Mark a document as checked against the original (who and when). */
export async function verifyEmployeeDocument(ctx: AuthContext, employeeId: string, documentId: string) {
  authorizeManage(ctx);
  // "Verified by" must be someone else for one's own documents (final review L2; Super Admin exempt) — which needs
  // the verifier's own link (KI-069).
  assertActorLinked(ctx);
  if (isOwnRecord(ctx, employeeId) && !ctx.isSuperAdmin) throw new ForbiddenError("You can't verify your own documents. Ask another administrator.");
  try {
    await prisma.$transaction(async (tx) => {
      await lockEmployee(tx, employeeId);
      const doc = await tx.employeeDocument.findFirst({ where: { id: documentId, employeeId, deletedAt: null }, select: { id: true, type: true, verifiedAt: true } });
      if (!doc) throw new NotFoundError("Document not found.");
      if (doc.verifiedAt) throw new ConflictError("This document is already verified.");
      await tx.employeeDocument.update({ where: { id: doc.id }, data: { verifiedAt: new Date(), verifiedById: ctx.userId } });
      await audit(tx, actorOf(ctx), { action: "employee_document.verify", entityType: "EmployeeDocument", entityId: doc.id, after: { employeeId, type: doc.type } });
    });
  } catch (e) {
    busy(e);
  }
}
