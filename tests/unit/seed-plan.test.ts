import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { passwordProblem } from "@/lib/auth/password";
import { ALL_PERMISSION_KEYS, ROLES } from "@/lib/rbac/catalog";
import { TargetGuardError } from "@/lib/db-target-guard";
import { decideSuperAdmin, newPermissionGrants, PLACEHOLDER_SETTINGS, planSeed, runGuardedSeed, SEED_ACTOR, SeedError, type SeedRunnerDeps, type SeedTransactionOptions } from "../../prisma/seed-core";

/**
 * R2/R4 (ADR-032) pure parts of the seed: the plan, the Super Admin decision and the guarded
 * runner's ordering. The transaction itself (rollback, idempotency, lock, audit rows) is covered by
 * tests/integration/seed.test.ts, pending a database. Prisma is not mocked: the runner's
 * transaction is an injected function that only records what it was given.
 */
describe("seed plan", () => {
  const plan = planSeed();
  it("is exactly the catalog: 85 permissions, 13 roles, 309 grants", () => {
    expect(plan.permissions).toHaveLength(85);
    expect(plan.roles).toHaveLength(13);
    expect(plan.totalGrants).toBe(309);
    expect(plan.permissions.map((p) => p.key)).toEqual([...ALL_PERMISSION_KEYS]);
    expect(plan.roles.map((r) => r.key)).toEqual(ROLES.map((r) => r.key));
  });
  it("is deterministic and matches docs/RBAC_MATRIX.md", () => {
    expect(planSeed()).toEqual(plan);
    const matrix = readFileSync(new URL("../../docs/RBAC_MATRIX.md", import.meta.url), "utf8");
    expect(matrix).toContain("Roles: 13 · Permissions: 85");
    for (const p of plan.permissions) expect(matrix).toContain(`\`${p.key}\``);
  });
  it("SUPER_ADMIN is the only system role and holds every permission with ALL scope", () => {
    expect(plan.roles.filter((r) => r.isSystem).map((r) => r.key)).toEqual(["SUPER_ADMIN"]);
    const sa = plan.roles.find((r) => r.key === "SUPER_ADMIN")!;
    expect(sa.grants.map((g) => g.key).sort()).toEqual([...ALL_PERMISSION_KEYS].sort());
    expect(sa.grants.every((g) => g.scope === "ALL")).toBe(true);
  });
  it("no non-system role gets user/role/backup/chatbot management", () => {
    for (const r of plan.roles.filter((x) => !x.isSystem)) {
      for (const k of ["user.manage", "role.manage", "backup.manage", "chatbot.manage"]) expect(r.grants.map((g) => g.key)).not.toContain(k);
    }
  });
  it("placeholder settings are obvious demo values (rule 13)", () => {
    expect(PLACEHOLDER_SETTINGS.name).toBe("Demo Public School");
    expect(PLACEHOLDER_SETTINGS.shortCode).toBe("DEMO");
    expect(PLACEHOLDER_SETTINGS.phones).toEqual([]);
    expect(JSON.stringify(PLACEHOLDER_SETTINGS)).not.toMatch(/@|\+91|\d{6}/); // no email, phone or PIN
  });
  it("audit actor is a labelled system actor, not a user", () => {
    expect(SEED_ACTOR).toEqual({ userId: null, label: "system:seed" });
  });
});

describe("Super Admin decision (R4)", () => {
  it("creates only when no active Super Admin exists and the username is free", () => {
    expect(decideSuperAdmin({ activeSuperAdminCount: 0, existingUser: null })).toEqual({ action: "create" });
  });
  it("skips when ANY active Super Admin exists — whatever the seed username (no second Super Admin)", () => {
    for (const existingUser of [null, { isActive: true, deleted: false, isSuperAdmin: true }, { isActive: true, deleted: false, isSuperAdmin: false }]) {
      expect(decideSuperAdmin({ activeSuperAdminCount: 1, existingUser }).action).toBe("skip");
    }
    expect(decideSuperAdmin({ activeSuperAdminCount: 2, existingUser: null }).action).toBe("skip");
  });
  it("never elevates an existing non–Super Admin account", () => {
    expect(() => decideSuperAdmin({ activeSuperAdminCount: 0, existingUser: { isActive: true, deleted: false, isSuperAdmin: false } })).toThrow(/never elevates/);
  });
  it("refuses a deactivated or deleted Super Admin's username (reactivate instead)", () => {
    for (const u of [{ isActive: false, deleted: false, isSuperAdmin: true }, { isActive: true, deleted: true, isSuperAdmin: true }]) {
      expect(() => decideSuperAdmin({ activeSuperAdminCount: 0, existingUser: u })).toThrow(/Reactivate/);
    }
  });
});

// ───────────────────────────── Guarded runner ordering (R1) ─────────────────────────────

const DEV = { branch: "br-dev-bbbb2222", ep: "ep-dev-bbbb2222" };
const PROD = { branch: "br-prod-aaaa1111", ep: "ep-prodn-aaaa1111" };
const PASSWORD = "Long-enough-pass-9";
const url = (ep: string) => `postgresql://neondb_owner:SYNTHETIC@${ep}-pooler.region.invalid/neondb?sslmode=verify-full`;
const fileEnv = (over: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: url(DEV.ep),
  TEST_DATABASE_URL: url("ep-test-cccc3333"),
  SEED_TARGET_BRANCH_ID: DEV.branch,
  SEED_TARGET_ENDPOINT_ID: DEV.ep,
  FORBIDDEN_BRANCH_IDS: PROD.branch,
  FORBIDDEN_ENDPOINT_IDS: PROD.ep,
  SEED_SUPERADMIN_USERNAME: "principal",
  SEED_SUPERADMIN_PASSWORD: PASSWORD,
  ...over,
});

function runner(opts: { shell?: Record<string, string>; file?: Record<string, string | undefined>; identity?: { branch: string | null; endpoint: string | null } } = {}) {
  const events: string[] = [];
  let txOptions: SeedTransactionOptions | null = null;
  const deps: SeedRunnerDeps = {
    shellEnv: opts.shell ?? { PATH: "/usr/bin" },
    loadEnvFile: () => (events.push("load .env"), fileEnv(opts.file)),
    preCheckIdentity: async () => (events.push("pre-check identity"), opts.identity ?? { branch: DEV.branch, endpoint: DEV.ep }),
    hashPassword: async (p) => (events.push("hash"), `argon2id$hash-of-${p.length}-chars`),
    passwordProblem,
    runTransaction: async (o) => {
      events.push("transaction");
      txOptions = o;
      return { stats: { permissionsCreated: 0, permissionsUpdated: 0, rolesCreated: [], grantsCreated: 0, newPermissionGrantsCreated: 0, grantScopesSynced: 0, settingsCreated: false, managedRoleKeys: [] }, superAdmin: { action: "skip", reason: "test" } };
    },
    log: (l) => void events.push(`log: ${l}`),
  };
  return { deps, events, tx: () => txOptions };
}

describe("runGuardedSeed — nothing reaches the transaction unless every guard passes", () => {
  it("happy path order: shell → .env → hash → read-only identity → ONE transaction", async () => {
    const r = runner();
    await runGuardedSeed(r.deps);
    expect(r.events.filter((e) => !e.startsWith("log"))).toEqual(["load .env", "hash", "pre-check identity", "transaction"]);
  });

  it("passes only a hash to the transaction — never the password", async () => {
    const r = runner();
    await runGuardedSeed(r.deps);
    const sa = r.tx()!.superAdmin!;
    expect(sa.username).toBe("principal");
    expect(sa.passwordHash).not.toContain(PASSWORD);
    expect(JSON.stringify(r.tx())).not.toContain(PASSWORD);
    expect(r.events.join("\n")).not.toContain(PASSWORD);
  });

  it("refuses before reading .env when the shell sets DOTENV_PATH or a database URL", async () => {
    const shells: Record<string, string>[] = [{ DOTENV_PATH: ".env.test" }, { DOTENV_CONFIG_PATH: ".env.test" }, { DATABASE_URL: url(PROD.ep) }, { DIRECT_URL: url(DEV.ep) }, { TEST_DATABASE_URL: url(DEV.ep) }];
    for (const shell of shells) {
      const r = runner({ shell });
      await expect(runGuardedSeed(r.deps)).rejects.toBeInstanceOf(TargetGuardError);
      expect(r.events).toEqual([]); // .env not even loaded
    }
  });

  it.each<[string, Record<string, string | undefined>]>([
    ["production URL", { DATABASE_URL: url(PROD.ep) }],
    ["test URL", { DATABASE_URL: url("ep-test-cccc3333") }],
    ["unknown URL", { DATABASE_URL: url("ep-other-dddd4444") }],
    ["no allow-list", { SEED_TARGET_ENDPOINT_ID: undefined }],
    ["no forbidden endpoints", { FORBIDDEN_ENDPOINT_IDS: undefined }],
  ])("refuses a %s before any connection or transaction", async (_l, file) => {
    const r = runner({ file });
    await expect(runGuardedSeed(r.deps)).rejects.toBeInstanceOf(TargetGuardError);
    expect(r.events).not.toContain("pre-check identity");
    expect(r.events).not.toContain("transaction");
  });

  it.each([
    ["production branch", { branch: PROD.branch, endpoint: DEV.ep }],
    ["test branch", { branch: "br-test-cccc3333", endpoint: DEV.ep }],
    ["non-Neon server", { branch: null, endpoint: null }],
  ])("refuses when the live server is the %s — no transaction", async (_l, identity) => {
    const r = runner({ identity });
    await expect(runGuardedSeed(r.deps)).rejects.toBeInstanceOf(TargetGuardError);
    expect(r.events).not.toContain("transaction");
  });

  it("rejects a weak seed password before connecting", async () => {
    const r = runner({ file: { SEED_SUPERADMIN_PASSWORD: "password123" } });
    await expect(runGuardedSeed(r.deps)).rejects.toBeInstanceOf(SeedError);
    expect(r.events).not.toContain("pre-check identity");
    expect(r.events).not.toContain("transaction");
  });

  it("without seed credentials: runs the catalog seed only (no Super Admin)", async () => {
    const r = runner({ file: { SEED_SUPERADMIN_PASSWORD: undefined } });
    await runGuardedSeed(r.deps);
    expect(r.tx()!.superAdmin).toBeNull();
    expect(r.events).not.toContain("hash");
  });

  it("the transaction re-verifies identity itself (fails closed inside the transaction too)", async () => {
    const r = runner();
    await runGuardedSeed(r.deps);
    const opts = r.tx()!;
    expect(opts.plan.totalGrants).toBe(309);
    expect(typeof opts.verifyIdentity).toBe("function");
  });
});

describe("new-permission grants on existing roles (Phase 2: academic.read)", () => {
  const plan = planSeed();
  it("an existing database receives academic.read on every role the catalog grants it to", () => {
    const rows = newPermissionGrants(plan, ["academic.read"], new Set());
    expect(rows).toEqual([
      { roleKey: "SCHOOL_ADMIN", key: "academic.read", scope: "ALL" },
      { roleKey: "PRINCIPAL", key: "academic.read", scope: "ALL" },
      { roleKey: "VICE_PRINCIPAL", key: "academic.read", scope: "ALL" },
      { roleKey: "ADMISSION_OFFICER", key: "academic.read", scope: "ALL" },
      { roleKey: "TEACHER", key: "academic.read", scope: "ASSIGNED" },
      { roleKey: "CLASS_TEACHER", key: "academic.read", scope: "ASSIGNED" },
    ]);
  });
  it("skips the system role (synced separately) and roles created in this run (granted in full)", () => {
    const rows = newPermissionGrants(plan, ["academic.read"], new Set(["TEACHER"]));
    expect(rows.map((r) => r.roleKey)).not.toContain("SUPER_ADMIN");
    expect(rows.map((r) => r.roleKey)).not.toContain("TEACHER");
  });
  it("adds nothing for permissions that already existed (admin edits are kept)", () => {
    expect(newPermissionGrants(plan, [], new Set())).toEqual([]);
  });
  it("with every permission new and no role created, equals all non-system catalog grants", () => {
    const rows = newPermissionGrants(plan, plan.permissions.map((p) => p.key), new Set());
    expect(rows).toHaveLength(plan.roles.filter((r) => !r.isSystem).reduce((n, r) => n + r.grants.length, 0));
  });
});
