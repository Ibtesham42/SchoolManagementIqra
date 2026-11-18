import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { renderPdf } from "@/lib/pdf/render";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import {
  currentVerificationKeyVersion,
  formatVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  normalizeVerificationCode,
  verificationHashCandidates,
} from "@/lib/verification-code";
import { discardUpload, prepareUpload, readStoredFile, recordUpload } from "@/modules/files/files.service";
import { getSchoolProfilePublic } from "@/modules/settings/settings.public";
import { buildBranding, type SchoolBranding } from "./branding";
import { DocumentPreview } from "./templates/document-preview";

/** Branding for documents: current settings + logo bytes (the logo is a PUBLIC file). */
export async function loadBranding(): Promise<SchoolBranding> {
  const profile = await getSchoolProfilePublic();
  let logo: { bytes: Buffer; mimeType: string } | null = null;
  if (profile.logoFileId) {
    // A missing/unreadable logo must not break document generation.
    logo = await readStoredFile(null, profile.logoFileId).catch(() => null);
  }
  return buildBranding(profile, logo);
}

/** Settings → "Preview documents". Requires settings.read; contains no personal data. */
export async function renderDocumentPreview(ctx: AuthContext): Promise<Buffer> {
  authorize(ctx, "settings.read");
  const branding = await loadBranding();
  return renderPdf(createElement(DocumentPreview, { branding, generatedAt: new Date() }));
}

// ───────────────────────────── Issued documents & verification ─────────────────────────────

export type GeneratedDocumentKind = "ID_CARD" | "CERTIFICATE" | "RECEIPT" | "REPORT_CARD" | "SALARY_SLIP" | "OTHER";

export interface IssueDocumentInput {
  type: GeneratedDocumentKind;
  /** The record the document is about, already authorized by the calling module's policy. */
  subject: { type: string; id: string };
  fileName: string;
}

const SUBJECT_TYPE = /^[A-Z][A-Za-z]{1,39}$/;
const SUBJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

/**
 * Registers and stores an issued PDF. `render` receives the verification code so it can be printed
 * on the document; the code is returned once and only its HMAC is stored. The PDF is always a
 * PRIVATE file owned by the registry entry. Rendering runs before (outside) the transaction.
 */
export async function issueDocument(
  ctx: AuthContext,
  input: IssueDocumentInput,
  render: (verificationCode: string) => Promise<Uint8Array>,
): Promise<{ id: string; verificationCode: string }> {
  authorize(ctx, "document.generate");
  if (!SUBJECT_TYPE.test(input.subject.type) || !SUBJECT_ID.test(input.subject.id)) throw new ValidationError("Invalid document subject.");

  const code = generateVerificationCode();
  const keyVersion = currentVerificationKeyVersion();
  const codeHash = hashVerificationCode(code, keyVersion); // fails early if the key is not configured
  const id = randomBytes(16).toString("hex");
  const pdf = await render(formatVerificationCode(code));
  const prepared = await prepareUpload(ctx, "document.pdf", pdf, input.fileName, { type: "GeneratedDocument", id });
  if (prepared.visibility !== "PRIVATE") {
    await discardUpload(prepared);
    throw new Error("Generated documents must be stored privately."); // guards a future rule edit
  }
  try {
    await prisma.$transaction(async (tx) => {
      const file = await recordUpload(tx, ctx, prepared);
      await tx.generatedDocument.create({
        data: {
          id,
          type: input.type,
          verificationCodeHash: codeHash,
          verificationKeyVersion: keyVersion,
          subjectType: input.subject.type,
          subjectId: input.subject.id,
          fileId: file.id,
          generatedById: ctx.userId,
        },
        select: { id: true },
      });
      // The code itself is never audited, logged or stored.
      await audit(tx, actorOf(ctx), { action: "document.issue", entityType: "GeneratedDocument", entityId: id, after: { type: input.type, subjectType: input.subject.type, subjectId: input.subject.id, fileId: file.id } });
    });
  } catch (e) {
    await discardUpload(prepared);
    throw e;
  }
  return { id, verificationCode: formatVerificationCode(code) };
}

/**
 * Revocation is a separate authority from generation (document.revoke: Super Admin, Principal by
 * default): whoever can issue a document cannot, by that alone, invalidate one.
 */
export async function revokeDocument(ctx: AuthContext, id: string, reason: string): Promise<void> {
  authorize(ctx, "document.revoke");
  const why = reason.trim();
  if (why.length < 3 || why.length > 500) throw new ValidationError("Give a reason (3–500 characters).", [{ path: "reason", message: "3–500 characters." }]);
  await prisma.$transaction(async (tx) => {
    const updated = await tx.generatedDocument.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(), revokedById: ctx.userId, revocationReason: why } });
    if (updated.count === 0) {
      const exists = await tx.generatedDocument.findUnique({ where: { id }, select: { id: true } });
      if (!exists) throw new NotFoundError("Document not found.");
      throw new ConflictError("This document is already revoked.");
    }
    await audit(tx, actorOf(ctx), { action: "document.revoke", entityType: "GeneratedDocument", entityId: id, after: { reason: why } });
  });
}

/** Everything the public verification page may show. No names, ids, subjects or files. */
export type PublicVerification =
  | { status: "valid"; type: GeneratedDocumentKind; issuedOn: string; issuer: string }
  | { status: "revoked" }
  | { status: "not_found" };

/** Pure: registry row → minimal public answer. Revoked documents never report as valid. */
export function toPublicVerification(
  row: { type: GeneratedDocumentKind; generatedAt: Date; revokedAt: Date | null } | null,
  issuer: string,
  timeZone: string,
): PublicVerification {
  if (!row) return { status: "not_found" };
  if (row.revokedAt) return { status: "revoked" };
  // Calendar date only (in the school's zone) — the exact time adds nothing for a verifier.
  const issuedOn = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(row.generatedAt);
  return { status: "valid", type: row.type, issuedOn, issuer };
}

/** Pure: a row matches only if its hash was produced by the key version it records. */
export function matchVerificationRow<T extends { verificationCodeHash: string; verificationKeyVersion: number }>(
  rows: T[],
  candidates: { version: number; hash: string }[],
): T | null {
  return rows.find((r) => candidates.some((c) => c.version === r.verificationKeyVersion && c.hash === r.verificationCodeHash)) ?? null;
}

/**
 * Public, unauthenticated verification. Malformed codes are rejected without touching the database.
 * The public route that calls this must add rate limiting and caching (not built yet — KI-037).
 */
export async function verifyDocument(code: string): Promise<PublicVerification> {
  const normalized = normalizeVerificationCode(code);
  if (!normalized) return { status: "not_found" };
  // One indexed lookup covering every configured key version (current + rotated-out keys).
  const candidates = verificationHashCandidates(normalized);
  const rows = await prisma.generatedDocument.findMany({
    where: { verificationCodeHash: { in: candidates.map((c) => c.hash) } },
    select: { type: true, generatedAt: true, revokedAt: true, verificationCodeHash: true, verificationKeyVersion: true },
    take: candidates.length,
  });
  const row = matchVerificationRow(rows, candidates);
  const profile = await getSchoolProfilePublic();
  return toPublicVerification(row, profile.name, profile.timezone);
}
