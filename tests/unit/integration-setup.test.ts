import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planSeed } from "../../prisma/seed-core";
import { bigintSafe } from "../bigint-json";
import { CATALOG_COUNTS } from "../integration/catalog-setup";
import { SCOPE_TIMEOUTS } from "../test-scope";

/**
 * KI-044 (G5 run 1 fixes) — checked statically and purely; nothing here touches a database.
 * The integration suites themselves run only via `npm run test:integration` (G5, owner-approved).
 */
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const SUITES_WITH_CATALOG = ["documents", "identity-admin", "settings-files", "phase1"];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("integration-only timeouts", () => {
  const load = async (event: string | undefined) => {
    vi.resetModules();
    vi.stubEnv("npm_lifecycle_event", event as string);
    return ((await import("../../vitest.config")).default as { test: { testTimeout?: number; hookTimeout?: number } }).test;
  };
  it("integration scope: 60 s per test, 180 s per setup hook", async () => {
    expect(SCOPE_TIMEOUTS.integration).toEqual({ testTimeout: 60_000, hookTimeout: 180_000 });
    const t = await load("test:integration");
    expect(t.testTimeout).toBe(60_000);
    expect(t.hookTimeout).toBe(180_000);
  });
  it.each(["test", "test:unit", undefined])("unit scope (%s) keeps Vitest's defaults", async (event) => {
    expect(SCOPE_TIMEOUTS.unit).toEqual({});
    const t = await load(event);
    expect(t.testTimeout).toBeUndefined();
    expect(t.hookTimeout).toBeUndefined();
  });
});

describe("catalog setup via the transactional seed core", () => {
  it("expects exactly the catalog the seed core plans: 82 permissions, 13 roles, 271 grants", () => {
    const plan = planSeed();
    expect(CATALOG_COUNTS).toEqual({ permissions: 82, roles: 13, grants: 271 });
    expect([plan.permissions.length, plan.roles.length, plan.totalGrants]).toEqual([82, 13, 271]);
  });
  it("is catalog-only: no Super Admin, no user, and every catalog role verified exactly", () => {
    const src = read("../integration/catalog-setup.ts");
    expect(src).toMatch(/seedInTransaction\(tx, \{ plan, superAdmin: null/);
    expect(src).toMatch(/verifySeed\(tx, plan, plan\.roles\.map\(\(r\) => r\.key\)\)/);
    expect(src).not.toMatch(/user\.create|SEED_SUPERADMIN|passwordHash/);
    expect(src).toMatch(/\$transaction\(/);
  });
  it.each(SUITES_WITH_CATALOG)("%s uses ensureCatalog() instead of row-by-row upserts", (name) => {
    const src = read(`../integration/${name}.test.ts`);
    expect(src).toMatch(/\(await import\("\.\/catalog-setup"\)\)\.ensureCatalog\(\)/);
    expect(src).not.toMatch(/for \(const key of ALL_PERMISSION_KEYS\)/);
    expect(src).not.toMatch(/prisma\.rolePermission\.upsert\(/);
    expect(src).not.toMatch(/prisma\.permission\.upsert\(\{ where: \{ key \}/);
  });
  it("existing RBAC assertions are preserved (phase1 still compares every role with the catalog)", () => {
    const src = read("../integration/phase1.test.ts");
    expect(src).toContain("all 13 roles: permissions loaded from the DB through a real session match the catalog exactly");
    expect(src).toMatch(/expect\(ctx\.permissions\.size\)\.toBe\(expected\.size\)/);
  });
});

describe("50-concurrent-transaction stress tests", () => {
  const src = read("../integration/phase1.test.ts");
  it("Prisma stress test passes explicit maxWait and timeout", () => {
    expect(src).toMatch(/prisma\.\$transaction\(\(tx\) => nextSequence\(tx, key\), \{ maxWait: 60_000, timeout: 60_000 \}\)/);
  });
  it("raw-connection stress test sets explicit connect/statement/query timeouts", () => {
    expect(src).toMatch(/connectionTimeoutMillis: 60_000, statement_timeout: 60_000, query_timeout: 60_000/);
  });
  it("uniqueness assertions are unchanged in both", () => {
    expect(src.match(/expect\(new Set\(values\)\.size\)\.toBe\(50\)/g)?.length).toBe(2);
    expect(src).toMatch(/toEqual\(Array\.from\(\{ length: 50 \}, \(_, i\) => i \+ 1\)\)/);
  });
  it("app-wide transaction limits are exactly the owner-approved D11 values (KI-044)", () => {
    const db = read("../../src/lib/db.ts");
    expect(db).toContain("export const TX_MAX_WAIT_MS = 10_000;");
    expect(db).toContain("export const TX_TIMEOUT_MS = 15_000;");
    expect(db).toContain("transactionOptions: { maxWait: TX_MAX_WAIT_MS, timeout: TX_TIMEOUT_MS }");
  });
});

describe("BigInt-safe JSON in the seed integration test", () => {
  it("encodes BigInt as a string instead of throwing", () => {
    expect(() => JSON.stringify({ id: 5n })).toThrow(/BigInt/);
    expect(JSON.stringify({ id: 5n, nested: [{ id: 7n }], n: 1 }, bigintSafe)).toBe('{"id":"5","nested":[{"id":"7"}],"n":1}');
  });
  it("is used where audit rows are serialized", () => {
    const src = read("../integration/seed.test.ts");
    expect(src).toMatch(/JSON\.stringify\(r\.audits, bigintSafe\)/);
    expect(src).not.toMatch(/JSON\.stringify\(r\.audits\)\)/);
  });
});

describe("G5 run 2 test fixes (static checks)", () => {
  it("documents.test.ts serializes audit rows BigInt-safely", () => {
    const src = read("../integration/documents.test.ts");
    expect(src).toMatch(/JSON\.stringify\(auditRows, bigintSafe\)/);
    expect(src).not.toMatch(/JSON\.stringify\(auditRows\)\)/);
  });
  it("escalation test keeps the Librarian's grants and adds only payroll.read", () => {
    const src = read("../integration/identity-admin.test.ts");
    expect(src).toMatch(/rolePermission\.findMany\(\{ where: \{ roleId: lib\.id \}/);
    expect(src).toMatch(/grants: \[\.\.\.libGrants, \{ key: "payroll\.read", scope: "ALL" \}\]/);
    expect(src).toMatch(/\.rejects\.toThrow\(\/payroll\.read\/\)/); // the intended violation is still asserted
  });
  it("legacy-file test stores a real encrypted blob before reading it", () => {
    const src = read("../integration/settings-files.test.ts");
    const put = src.indexOf("await driver.put(storageKey, enc.data)");
    const read1 = src.indexOf("await m.readStoredFile(superCtx!, legacy.id)");
    expect(put).toBeGreaterThan(-1);
    expect(read1).toBeGreaterThan(put);
    expect(src).toMatch(/keyVersion: enc\.keyVersion/);
    expect(src).toMatch(/Buffer\.from\(asSuper\.bytes\)\.equals\(plain\)/);
  });
});
