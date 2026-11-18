import { describe, expect, it } from "vitest";
import { MemoryDriver, newStorageKey } from "@/lib/storage/driver";
import { planPurge, PURGE_GRACE_DAYS } from "@/modules/files/files-purge";

/**
 * S-15 purge lifecycle (owner decision 2026-11-18) — pure planning only. The job itself runs against real Postgres
 * (never a mocked Prisma — testing rules) in tests/integration/files-purge.test.ts.
 */
const NOW = new Date("2026-12-31T00:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe("planPurge", () => {
  it("only files retired at least 30 days ago with a valid storage key are purged", () => {
    const ok = newStorageKey("PRIVATE", daysAgo(40));
    const plan = planPurge(
      [
        { id: "old", storageKey: ok, deletedAt: daysAgo(PURGE_GRACE_DAYS) },
        { id: "recent", storageKey: ok, deletedAt: daysAgo(PURGE_GRACE_DAYS - 1) },
        { id: "bad", storageKey: "../../etc/passwd", deletedAt: daysAgo(90) },
      ],
      NOW,
    );
    expect(plan.purge.map((p) => p.id)).toEqual(["old"]);
    expect(plan.notYet).toEqual(["recent"]);
    expect(plan.invalidKey).toEqual(["bad"]);
  });
});

describe("orphan reconciliation planning (KI-067)", () => {
  it("only unreferenced blobs older than 24 h are orphans", async () => {
    const { planOrphans, ORPHAN_MIN_AGE_HOURS } = await import("@/modules/files/files-purge");
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
    const listed = [
      { key: "private/2026/12/aaaaaaaaaaaaaaaaaaaaaaaa", modifiedAt: hoursAgo(ORPHAN_MIN_AGE_HOURS + 1) }, // orphan
      { key: "private/2026/12/bbbbbbbbbbbbbbbbbbbbbbbb", modifiedAt: hoursAgo(1) }, // too young (upload in flight)
      { key: "private/2026/12/cccccccccccccccccccccccc", modifiedAt: hoursAgo(100) }, // referenced
    ];
    expect(planOrphans(listed, new Set(["private/2026/12/cccccccccccccccccccccccc"]), NOW)).toEqual(["private/2026/12/aaaaaaaaaaaaaaaaaaaaaaaa"]);
  });

  it("LocalDriver.listPrivate returns strict-pattern private keys only (temp files, public keys and junk ignored)", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { LocalDriver } = await import("@/lib/storage/driver");
    const root = await mkdtemp(join(tmpdir(), "erp-list-"));
    try {
      const d = new LocalDriver(root);
      const good = newStorageKey("PRIVATE", NOW);
      await d.put(good, new Uint8Array([1]));
      await d.put(newStorageKey("PUBLIC", NOW), new Uint8Array([2]));
      const dir = join(root, "private", "2026", "12");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "partial.abc123.tmp"), "x");
      await writeFile(join(dir, "notes.txt"), "x");
      await mkdir(join(root, "private", "junk"), { recursive: true });
      const listed = await d.listPrivate(100);
      expect(listed.map((x) => x.key)).toEqual([good]);
      expect(listed[0].modifiedAt).toBeInstanceOf(Date);
      expect((await d.listPrivate(0)).length).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
