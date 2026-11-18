import type { Db } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { assertValidKey, LIST_PRIVATE_MAX, type StorageDriver } from "@/lib/storage/driver";

/**
 * S-15 private-file purge lifecycle (owner decision 2026-11-18; SECURITY_AUDIT_2026-11-10_PHASE_2B.md Appendix A).
 *
 *   live → retired (stored_file.deleted_at, set by the owning service) → purge-eligible after PURGE_GRACE_DAYS
 *   → purged: the job deletes the encrypted blob, THEN sets purged_at; the metadata row (id, purpose, owner,
 *   size, sha256 — no content) is kept so audit trails stay resolvable.
 *
 * Safety: dry run by default (reads only, writes nothing); batches; only keys matching the strict storage-key
 * pattern are ever deleted (others are counted and left alone); blob delete is idempotent; failures are counted
 * by error NAME (no file names, content or keys in logs); one `file.purge` audit entry per applied batch with
 * counts and ids only. Requires migration 20261118000100 (purged_at). Orphan blobs (no row) are handled by `reconcileOrphans` below.
 */
export const PURGE_GRACE_DAYS = 30;
export const PURGE_BATCH = 200;

export interface PurgeCandidate {
  id: string;
  storageKey: string;
  deletedAt: Date;
}

/** Pure: which retired rows are past the grace period, and which of those have a key we may delete. */
export function planPurge(rows: readonly PurgeCandidate[], now: Date, graceDays = PURGE_GRACE_DAYS): { purge: PurgeCandidate[]; invalidKey: string[]; notYet: string[] } {
  const cutoff = now.getTime() - graceDays * 86_400_000;
  const purge: PurgeCandidate[] = [];
  const invalidKey: string[] = [];
  const notYet: string[] = [];
  for (const r of rows) {
    if (r.deletedAt.getTime() > cutoff) {
      notYet.push(r.id);
      continue;
    }
    try {
      assertValidKey(r.storageKey);
      purge.push(r);
    } catch {
      invalidKey.push(r.id);
    }
  }
  return { purge, invalidKey, notYet };
}

export interface PurgeResult {
  dryRun: boolean;
  eligible: number;
  purged: number;
  invalidKey: number;
  failed: number;
  failures: Record<string, number>;
}

/**
 * One batch. The caller (scripts/files-purge.ts) has verified the target database and storage root. Dry run:
 * selects only. Apply: per file — delete the blob, then mark the row purged (guarded `purged_at IS NULL`), so
 * a crash between the two leaves an unpurged row whose blob is already gone; the next run deletes nothing new
 * (idempotent delete) and marks it.
 */
export async function purgeRetiredFiles(deps: { db: Db; driver: StorageDriver; actor: AuditActor; now?: Date; dryRun: boolean; batch?: number }): Promise<PurgeResult> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - PURGE_GRACE_DAYS * 86_400_000);
  const rows = await deps.db.storedFile.findMany({
    where: { deletedAt: { not: null, lte: cutoff }, purgedAt: null },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take: deps.batch ?? PURGE_BATCH,
    select: { id: true, storageKey: true, deletedAt: true },
  });
  const plan = planPurge(
    rows.map((r) => ({ id: r.id, storageKey: r.storageKey, deletedAt: r.deletedAt! })),
    now,
  );
  const result: PurgeResult = { dryRun: deps.dryRun, eligible: plan.purge.length, purged: 0, invalidKey: plan.invalidKey.length, failed: 0, failures: {} };
  if (deps.dryRun) return result;

  const purgedIds: string[] = [];
  for (const f of plan.purge) {
    try {
      await deps.driver.delete(f.storageKey);
      const r = await deps.db.storedFile.updateMany({ where: { id: f.id, purgedAt: null, deletedAt: { not: null } }, data: { purgedAt: now } });
      if (r.count === 1) purgedIds.push(f.id);
    } catch (e) {
      const name = e instanceof Error ? e.name : "unknown";
      result.failures[name] = (result.failures[name] ?? 0) + 1;
      result.failed++;
    }
  }
  result.purged = purgedIds.length;
  if (purgedIds.length || result.failed || result.invalidKey) {
    await deps.db.$transaction((tx) =>
      audit(tx, deps.actor, {
        action: "file.purge",
        entityType: "StoredFile",
        entityId: "purge",
        after: { graceDays: PURGE_GRACE_DAYS, purged: purgedIds.length, failed: result.failed, invalidKey: result.invalidKey, ids: purgedIds },
      }),
    );
  }
  return result;
}

// ───────────────────────────── Orphan reconciliation (Appendix A step 5; KI-067) ─────────────────────────────

/** Blobs younger than this are never touched: an upload writes the blob before its transaction commits. */
export const ORPHAN_MIN_AGE_HOURS = 24;

export interface ReconcileResult {
  dryRun: boolean;
  listed: number;
  orphans: number;
  deleted: number;
  failed: number;
  failures: Record<string, number>;
  /** stored_file rows (live or retired, not purged) whose blob is missing — reported, never auto-fixed. */
  missingBlobs: number;
}

/**
 * Pure: private keys older than the minimum age that no stored_file row references (purged rows still count as
 * references — their blob is already gone, so they can't produce an orphan).
 */
export function planOrphans(listed: readonly { key: string; modifiedAt: Date }[], knownKeys: ReadonlySet<string>, now: Date): string[] {
  const cutoff = now.getTime() - ORPHAN_MIN_AGE_HOURS * 3_600_000;
  return listed.filter((b) => b.modifiedAt.getTime() <= cutoff && !knownKeys.has(b.key)).map((b) => b.key);
}

/**
 * SAFETY: the storage root must belong to exactly ONE database — another database's files would look like orphans.
 * The runner (scripts/files-purge.ts) uses the database and the storage root from the same `.env`. Dry run by
 * default; deletion only of strict-pattern private keys; failures counted by error name; one `file.reconcile`
 * audit entry with counts only (orphans have no rows, so no ids).
 */
export async function reconcileOrphans(deps: { db: Db; driver: StorageDriver; actor: AuditActor; now?: Date; dryRun: boolean; limit?: number; missingCheckLimit?: number }): Promise<ReconcileResult> {
  const now = deps.now ?? new Date();
  const listed = await deps.driver.listPrivate(deps.limit ?? LIST_PRIVATE_MAX);
  const known = new Set<string>();
  for (let i = 0; i < listed.length; i += 500) {
    const keys = listed.slice(i, i + 500).map((b) => b.key);
    for (const r of await deps.db.storedFile.findMany({ where: { storageKey: { in: keys } }, select: { storageKey: true } })) known.add(r.storageKey);
  }
  const orphans = planOrphans(listed, known, now);

  // Rows that should still have a blob (not purged): count those whose blob is missing.
  const rows = await deps.db.storedFile.findMany({ where: { visibility: "PRIVATE", purgedAt: null }, orderBy: { createdAt: "asc" }, take: deps.missingCheckLimit ?? 5_000, select: { storageKey: true } });
  let missingBlobs = 0;
  for (const r of rows) if (!(await deps.driver.exists(r.storageKey).catch(() => true))) missingBlobs++;

  const result: ReconcileResult = { dryRun: deps.dryRun, listed: listed.length, orphans: orphans.length, deleted: 0, failed: 0, failures: {}, missingBlobs };
  if (deps.dryRun) return result;
  for (const key of orphans) {
    try {
      assertValidKey(key);
      await deps.driver.delete(key);
      result.deleted++;
    } catch (e) {
      const name = e instanceof Error ? e.name : "unknown";
      result.failures[name] = (result.failures[name] ?? 0) + 1;
      result.failed++;
    }
  }
  if (result.deleted || result.failed) {
    await deps.db.$transaction((tx) =>
      audit(tx, deps.actor, { action: "file.reconcile", entityType: "StoredFile", entityId: "reconcile", after: { listed: result.listed, deleted: result.deleted, failed: result.failed, missingBlobs } }),
    );
  }
  return result;
}
