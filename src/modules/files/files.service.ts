import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { decryptBuffer, encryptBuffer, sha256Hex } from "@/lib/crypto";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { getStorageDriver, newStorageKey } from "@/lib/storage/driver";
import { isUploadPurpose, UPLOAD_RULES, validateUpload, type UploadPurpose, type UploadRule } from "@/lib/storage/upload-rules";

/**
 * The only module that touches file storage. Callers (e.g. settings for the logo) never write
 * blobs or StoredFile rows themselves.
 *
 * Upload is two-phase so the blob and the database row stay consistent:
 *   1. prepareUpload()  — authorize, validate content, encrypt PRIVATE files, write the blob;
 *   2. recordUpload(tx) — inside the caller's transaction: StoredFile row + audit entry;
 *   on transaction failure the caller calls discardUpload() to delete the orphaned blob.
 *
 * Every file has a purpose and an owning record. PRIVATE files are only served to a caller that
 * names the exact owner it has already authorized (record-scope policy in the owning module).
 */
export interface FileOwner {
  type: string;
  id: string;
}

export interface PreparedUpload {
  purpose: UploadPurpose;
  owner: FileOwner;
  storageKey: string;
  provider: string;
  visibility: "PUBLIC" | "PRIVATE";
  mimeType: string;
  originalName: string;
  sizeBytes: number;
  sha256: string;
  encrypted: boolean;
  keyVersion: number | null;
}

const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

const OWNER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function prepareUpload(ctx: AuthContext, purpose: UploadPurpose, bytes: Uint8Array, declaredName: string, owner: FileOwner): Promise<PreparedUpload> {
  const rule: UploadRule = UPLOAD_RULES[purpose];
  authorize(ctx, rule.uploadPermission);
  // Programming errors, not user input — but never let a file be filed under the wrong kind of record.
  if (owner.type !== rule.ownerType || !OWNER_ID.test(owner.id)) {
    throw new ValidationError(`A ${purpose} file must belong to a ${rule.ownerType}.`);
  }
  const v = validateUpload(bytes, declaredName, purpose);
  const plain = Buffer.from(bytes);
  const sha256 = sha256Hex(plain);

  let stored: Buffer = plain;
  let keyVersion: number | null = null;
  if (rule.visibility === "PRIVATE") {
    const enc = encryptBuffer(plain); // app-side AES-256-GCM: the provider only ever sees ciphertext
    stored = enc.data;
    keyVersion = enc.keyVersion;
  }

  const driver = getStorageDriver();
  const storageKey = newStorageKey(rule.visibility);
  await driver.put(storageKey, stored);
  return {
    purpose,
    owner,
    storageKey,
    provider: driver.name,
    visibility: rule.visibility,
    mimeType: v.mimeType,
    originalName: v.originalName,
    sizeBytes: v.sizeBytes,
    sha256,
    encrypted: rule.visibility === "PRIVATE",
    keyVersion,
  };
}

export async function recordUpload(tx: Tx, ctx: AuthContext, p: PreparedUpload): Promise<{ id: string }> {
  const row = await tx.storedFile.create({
    data: {
      visibility: p.visibility,
      provider: p.provider,
      storageKey: p.storageKey,
      originalName: p.originalName,
      mimeType: p.mimeType,
      sizeBytes: p.sizeBytes,
      sha256: p.sha256,
      encrypted: p.encrypted,
      keyVersion: p.keyVersion,
      uploadedById: ctx.userId,
      purpose: p.purpose,
      ownerType: p.owner.type,
      ownerId: p.owner.id,
    },
    select: { id: true },
  });
  await audit(tx, actorOf(ctx), {
    action: "file.upload",
    entityType: "StoredFile",
    entityId: row.id,
    after: { purpose: p.purpose, ownerType: p.owner.type, ownerId: p.owner.id, visibility: p.visibility, mimeType: p.mimeType, sizeBytes: p.sizeBytes, sha256: p.sha256 },
  });
  return row;
}

export async function discardUpload(p: PreparedUpload): Promise<void> {
  await getStorageDriver()
    .delete(p.storageKey)
    .catch(() => undefined);
}

/** Soft-delete inside the caller's transaction (blob removal is left to housekeeping). */
export async function retireStoredFile(tx: Tx, ctx: AuthContext, fileId: string): Promise<void> {
  await tx.storedFile.updateMany({ where: { id: fileId, deletedAt: null }, data: { deletedAt: new Date() } });
  await audit(tx, actorOf(ctx), { action: "file.retire", entityType: "StoredFile", entityId: fileId });
  publicCache.delete(fileId); // other instances stop serving it within PUBLIC_CACHE_TTL_MS
}

/** What a caller has authorized: "this file must be the <purpose> file of <owner>". */
export interface FileAccess {
  purpose: UploadPurpose;
  owner: FileOwner;
}

export interface FileAccessFacts {
  visibility: "PUBLIC" | "PRIVATE";
  purpose: string;
  ownerType: string | null;
  ownerId: string | null;
}

/**
 * Pure access rule.
 * - PUBLIC: anyone.
 * - PRIVATE: a signed-in user who has changed any temporary password, and either
 *   · Super Admin (any file; still audited), or
 *   · the caller passes `access` (the owning module has ALREADY applied its record-scope policy to
 *     that owner), the file really is that purpose for that exact owner, and the user holds the
 *     purpose's readPermission. A file id from another student/staff member therefore never
 *     matches, even if the id is guessed or tampered with.
 * - Unknown/legacy purposes ("unclassified", owner "LegacyFile"): Super Admin only — even if the
 *   row says PUBLIC, because nothing vouches for what a pre-purpose file contains.
 * Uploading a file grants no special right to read it later.
 */
export function canReadStoredFile(ctx: AuthContext | null, file: FileAccessFacts, access?: FileAccess): boolean {
  const purpose = file.purpose;
  const known = isUploadPurpose(purpose);
  if (file.visibility === "PUBLIC" && known) return true;
  if (!ctx || ctx.mustChangePassword) return false;
  if (ctx.isSuperAdmin) return true;
  if (!access || !isUploadPurpose(purpose)) return false;
  const rule: UploadRule = UPLOAD_RULES[purpose];
  if (rule.visibility !== "PRIVATE") return false;
  return (
    access.purpose === file.purpose &&
    access.owner.type === file.ownerType &&
    access.owner.id === file.ownerId &&
    // Phase 6B-M2: a portal account reads with the rule's portal permission (never the staff one) — and only where the
    // rule names one; its module ran assertPortalStudent for the owner's student first.
    (ctx.portal ? !!rule.portalReadPermission && hasPermission(ctx, rule.portalReadPermission) : hasPermission(ctx, rule.readPermission))
  );
}

export interface FileForDownload {
  bytes: Buffer;
  mimeType: string;
  originalName: string;
  visibility: "PUBLIC" | "PRIVATE";
  sha256: string;
  /**
   * True only when anonymous visitors may read the file (a PUBLIC file with a known purpose). Routes
   * must base shared-cache headers on this, never on `visibility` alone: a legacy "unclassified"
   * row can say PUBLIC yet be Super Admin–only.
   */
  publiclyReadable: boolean;
}

/**
 * PUBLIC files (the logo) are fetched by every anonymous page view; a small in-process cache keeps
 * those requests off the database (Neon free-tier compute). Bounded by entry count and size;
 * PRIVATE files are never cached.
 */
const PUBLIC_CACHE_TTL_MS = 10 * 60 * 1000;
const PUBLIC_CACHE_MAX_ENTRIES = 32;
const PUBLIC_CACHE_MAX_BYTES = 1024 * 1024;
const publicCache = new Map<string, { file: FileForDownload; expires: number }>();

/** Test hook. */
export function clearPublicFileCache(): void {
  publicCache.clear();
}

/** Throws NotFoundError for missing AND forbidden files, so existence isn't revealed. */
export async function readStoredFile(ctx: AuthContext | null, fileId: string, access?: FileAccess, now = Date.now()): Promise<FileForDownload> {
  const cached = publicCache.get(fileId);
  if (cached && cached.expires > now) return cached.file;
  if (cached) publicCache.delete(fileId);

  const file = await prisma.storedFile.findFirst({
    where: { id: fileId, deletedAt: null },
    select: { id: true, visibility: true, purpose: true, ownerType: true, ownerId: true, storageKey: true, mimeType: true, originalName: true, encrypted: true, keyVersion: true, sha256: true },
  });
  if (!file || !canReadStoredFile(ctx, file, access)) throw new NotFoundError("File not found.");
  const publiclyReadable = canReadStoredFile(null, file);

  const raw = await getStorageDriver().get(file.storageKey);
  const bytes = file.encrypted ? decryptBuffer(raw, file.keyVersion ?? 1) : raw;
  if (ctx && !publiclyReadable) { // every non-public read (PRIVATE or legacy) is audited
    await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "file.download", entityType: "StoredFile", entityId: file.id }));
  }
  const result: FileForDownload = { bytes, mimeType: file.mimeType, originalName: file.originalName, visibility: file.visibility, sha256: file.sha256, publiclyReadable };
  // Cache only what anonymous visitors may read anyway (never PRIVATE or legacy files).
  if (publiclyReadable && bytes.length <= PUBLIC_CACHE_MAX_BYTES) {
    if (publicCache.size >= PUBLIC_CACHE_MAX_ENTRIES) publicCache.delete(publicCache.keys().next().value!);
    publicCache.set(fileId, { file: result, expires: now + PUBLIC_CACHE_TTL_MS });
  }
  return result;
}
