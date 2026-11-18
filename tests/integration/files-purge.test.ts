import { afterAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * S-15 purge job against real Postgres (Test branch only, behind the S-05 guard) with the in-memory storage driver.
 * Skips itself until migration 20261118000100 (stored_file.purged_at) is applied to Test. Synthetic rows only,
 * removed afterwards (audit rows kept).
 * NOTE (review before the first M6 run): the job is school-wide by design, so on Test it also marks OTHER retired
 * stored_file rows older than 30 days as purged (their blobs aren't in the memory driver; delete is idempotent).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/modules/files/files-purge")),
});
const m = enabled
  ? await load()
  : (null as unknown as Awaited<ReturnType<typeof load>>);
const migrated = enabled
  ? (
      await m.prisma.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*) AS n FROM _prisma_migrations WHERE migration_name = '20261118000100_stored_file_purged_at' AND finished_at IS NOT NULL`
    )[0].n > 0n
  : false;

describe.skipIf(!enabled)("S-15 purge job (integration)", () => {
  describe.skipIf(!migrated)("after migration 20261118000100", () => {
    const run = `fp${Date.now().toString(36)}`;
    const ids: string[] = [];
    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const actor = { userId: null, label: `system:test-${run}` };

    async function file(
      deletedDaysAgo: number | null,
      driver: InstanceType<typeof m.MemoryDriver>,
    ) {
      const storageKey = m.newStorageKey("PRIVATE", now);
      await driver.put(storageKey, new Uint8Array([1, 2, 3]));
      const row = await m.prisma.storedFile.create({
        data: {
          visibility: "PRIVATE",
          provider: "memory",
          storageKey,
          originalName: `${run}.pdf`,
          mimeType: "application/pdf",
          sizeBytes: 3,
          sha256: "0".repeat(64),
          encrypted: true,
          keyVersion: 1,
          purpose: "document.pdf",
          ownerType: "GeneratedDocument",
          ownerId: run,
          deletedAt: deletedDaysAgo === null ? null : daysAgo(deletedDaysAgo),
        },
        select: { id: true, storageKey: true },
      });
      ids.push(row.id);
      return row;
    }

    afterAll(async () => {
      await m.prisma.storedFile.deleteMany({ where: { id: { in: ids } } });
      await m.prisma.$disconnect();
    });

    it("dry run writes nothing; apply purges only files retired ≥ 30 days ago, keeps the row, audits ids; idempotent; CHECK holds", async () => {
      const driver = new m.MemoryDriver();
      const [old, recent, live] = [
        await file(40, driver),
        await file(5, driver),
        await file(null, driver),
      ];
      const dry = await m.purgeRetiredFiles({
        db: m.prisma,
        driver,
        actor,
        now,
        dryRun: true,
        batch: 10_000,
      });
      expect(dry.purged).toBe(0);
      expect(await driver.exists(old.storageKey)).toBe(true);

      await m.purgeRetiredFiles({
        db: m.prisma,
        driver,
        actor,
        now,
        dryRun: false,
        batch: 10_000,
      });
      expect([
        await driver.exists(old.storageKey),
        await driver.exists(recent.storageKey),
        await driver.exists(live.storageKey),
      ]).toEqual([false, true, true]);
      const rows = await m.prisma.storedFile.findMany({
        where: { id: { in: [old.id, recent.id, live.id] } },
        select: { id: true, purgedAt: true },
      });
      expect(rows.find((r) => r.id === old.id)?.purgedAt).not.toBeNull();
      expect(
        rows
          .filter((r) => r.purgedAt === null)
          .map((r) => r.id)
          .sort(),
      ).toEqual([recent.id, live.id].sort());
      const log = await m.prisma.auditLog.findFirstOrThrow({
        where: { action: "file.purge", actorLabel: actor.label },
      });
      expect(JSON.stringify(log.after)).toContain(old.id);
      expect(JSON.stringify(log.after)).not.toContain(old.storageKey);
      // The database refuses marking a live file purged.
      await expect(
        m.prisma.storedFile.updateMany({
          where: { id: live.id },
          data: { purgedAt: now },
        }),
      ).rejects.toThrow();
    });
  });
});
