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
