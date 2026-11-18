import type { Db } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { assertValidKey, type StorageDriver } from "@/lib/storage/driver";

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
 * counts and ids only. Requires migration 20261118000100 (purged_at). Orphan-blob reconciliation (blobs with
 * no row) needs a listing capability in the storage driver — not implemented yet (KI-067).
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
