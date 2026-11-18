/**
 * Seed core (ADR-032). The seed is ONE interactive transaction:
 *
 *   lockSuperAdminGuard (first statement, rule 17)
 *   → re-verify the server identity (target guard, src/lib/db-target-guard)
 *   → permissions, roles, grants, placeholder settings (batched, idempotent)
 *   → initial Super Admin (only if no active Super Admin exists — never a second one)
 *   → audit entries (same transaction, rule 6)
 *   → verifySeed: the catalog is fully present, else throw → everything rolls back
 *   → commit
 *
 * An interrupted run therefore leaves nothing half-done, and a re-run is idempotent. Existing grants
 * of non-system roles are never touched (admin edits are kept) — the one addition: a permission that
 * is new in this run gets its catalog default grants on existing roles too. The system SUPER_ADMIN
 * role always holds the whole catalog.
 *
 * Pure parts (planSeed, decideSuperAdmin, runGuardedSeed's ordering) are unit-tested in
 * tests/unit/seed-plan.test.ts; the transaction is integration-tested in
 * tests/integration/seed.test.ts.
 */
import type { Tx } from "../src/lib/db";
import { audit, type AuditActor } from "../src/lib/audit";
import { ALL_PERMISSION_KEYS, PERMISSIONS, ROLES, moduleOf, normalizeGrant, type PermissionKey, type Scope } from "../src/lib/rbac/catalog";
import { assertLiveIdentity, assertShellClean, resolveSeedTarget, type DbIdentity, type SeedTarget } from "../src/lib/db-target-guard";
import { SUPER_ADMIN } from "../src/modules/identity/identity.policy";
import { activeSuperAdminIds, lockSuperAdminGuard } from "../src/modules/identity/super-admin-guard";

export class SeedError extends Error {}

/** Audit actor for everything the seed writes (no user exists yet). */
export const SEED_ACTOR: AuditActor = { userId: null, label: "system:seed" };

// ───────────────────────────── Plan (pure) ─────────────────────────────

export interface PlannedRole {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  grants: { key: PermissionKey; scope: Scope }[];
}
export interface SeedPlan {
  permissions: { key: PermissionKey; module: string; description: string }[];
  roles: PlannedRole[];
  totalGrants: number;
}

export function planSeed(): SeedPlan {
  const permissions = ALL_PERMISSION_KEYS.map((key) => ({ key, module: moduleOf(key), description: PERMISSIONS[key] }));
  const roles = ROLES.map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem ?? false,
    grants: r.grants.map(normalizeGrant),
  }));
  for (const r of roles) {
    if (new Set(r.grants.map((g) => g.key)).size !== r.grants.length) throw new SeedError(`Catalog error: duplicate grant in role ${r.key}`);
  }
  return { permissions, roles, totalGrants: roles.reduce((n, r) => n + r.grants.length, 0) };
}

/**
 * Pure: catalog default grants of permissions that are NEW in this run, for existing non-system roles
 * (system roles and roles created in this run already receive their full catalog grants).
 */
export function newPermissionGrants(plan: SeedPlan, newPermissionKeys: Iterable<PermissionKey>, createdRoleKeys: ReadonlySet<string>): { roleKey: string; key: PermissionKey; scope: Scope }[] {
  const fresh = new Set(newPermissionKeys);
  return plan.roles
    .filter((r) => !r.isSystem && !createdRoleKeys.has(r.key))
    .flatMap((r) => r.grants.filter((g) => fresh.has(g.key)).map((g) => ({ roleKey: r.key, key: g.key, scope: g.scope })));
}

/** Placeholder school settings — obvious demo values, replaced in Settings (rule 13). */
export const PLACEHOLDER_SETTINGS = {
  name: "Demo Public School",
  shortCode: "DEMO",
  phones: [] as string[],
  timezone: "Asia/Kolkata",
  idFormats: {
    studentId: "{CODE}-{YYYY}-{SEQ:4}",
    admissionNo: "ADM-{YYYY}-{SEQ:4}",
    employeeCode: "EMP-{SEQ:4}",
    receiptNo: "RCPT-{SESSION}-{SEQ:5}",
  },
  rollNumberRules: { sort: "fullName", tieBreak: ["dob", "studentCode"], lateAdmission: "append" },
};

// ───────────────────────────── Super Admin decision (pure) ─────────────────────────────

export interface SuperAdminFacts {
  activeSuperAdminCount: number;
  /** The user that already has the seed username, if any. */
  existingUser: null | { isActive: boolean; deleted: boolean; isSuperAdmin: boolean };
}
export type SuperAdminDecision = { action: "create" } | { action: "skip"; reason: string };

/**
 * Never creates a second Super Admin and never elevates or changes an existing account:
 *  - any active Super Admin exists (whatever its username) → skip;
 *  - no active Super Admin, username free → create;
 *  - no active Super Admin, username taken (non-Super Admin, or a deactivated/deleted Super Admin) → refuse.
 */
export function decideSuperAdmin(f: SuperAdminFacts): SuperAdminDecision {
  if (f.activeSuperAdminCount > 0) return { action: "skip", reason: `a Super Admin already exists (${f.activeSuperAdminCount}) — not creating another; SEED_SUPERADMIN_* ignored` };
  if (!f.existingUser) return { action: "create" };
  if (f.existingUser.isSuperAdmin) {
    throw new SeedError("The seed username belongs to a deactivated or deleted Super Admin. Reactivate that account instead of seeding a new one. Nothing was written.");
  }
  throw new SeedError("The seed username belongs to an existing non–Super Admin user; the seed never elevates an existing account. Choose another SEED_SUPERADMIN_USERNAME. Nothing was written.");
}

// ───────────────────────────── Writes (inside the caller's transaction) ─────────────────────────────

export interface SeedStats {
  permissionsCreated: number;
  permissionsUpdated: number;
  rolesCreated: string[];
  grantsCreated: number;
  /** Default grants of permissions created in this run, added to existing non-system roles. */
  newPermissionGrantsCreated: number;
  grantScopesSynced: number;
  settingsCreated: boolean;
  /** Roles whose grants this run owns: roles created now + system roles. */
  managedRoleKeys: string[];
}

export async function applySeed(tx: Tx, plan: SeedPlan): Promise<SeedStats> {
  // Permissions: insert missing in one statement; refresh changed module/description only.
  const existingPerms = new Map((await tx.permission.findMany({ select: { key: true, module: true, description: true } })).map((p) => [p.key, p]));
  const missingPerms = plan.permissions.filter((p) => !existingPerms.has(p.key));
  const permsCreated = missingPerms.length ? (await tx.permission.createMany({ data: missingPerms, skipDuplicates: true })).count : 0;
  let permissionsUpdated = 0;
  for (const p of plan.permissions) {
    const e = existingPerms.get(p.key);
    if (e && (e.module !== p.module || e.description !== p.description)) {
      await tx.permission.update({ where: { key: p.key }, data: { module: p.module, description: p.description } });
      permissionsUpdated++;
    }
  }
  const permIds = new Map((await tx.permission.findMany({ where: { key: { in: plan.permissions.map((p) => p.key) } }, select: { id: true, key: true } })).map((p) => [p.key, p.id]));

  // Roles: create the missing ones; existing roles are left as they are.
  const roleKeys = plan.roles.map((r) => r.key);
  const existingRoleKeys = new Set((await tx.role.findMany({ where: { key: { in: roleKeys } }, select: { key: true } })).map((r) => r.key));
  const missingRoles = plan.roles.filter((r) => !existingRoleKeys.has(r.key));
  if (missingRoles.length) {
    await tx.role.createMany({ data: missingRoles.map((r) => ({ key: r.key, name: r.name, description: r.description, isSystem: r.isSystem })), skipDuplicates: true });
  }
  const roleIds = new Map((await tx.role.findMany({ where: { key: { in: roleKeys } }, select: { id: true, key: true } })).map((r) => [r.key, r.id]));

  // Grants: only for roles created in this run and for system roles (admin-edited roles are kept).
  const created = new Set(missingRoles.map((r) => r.key));
  const managed = plan.roles.filter((r) => r.isSystem || created.has(r.key));
  const rows = managed.flatMap((r) =>
    r.grants.map((g) => {
      const roleId = roleIds.get(r.key);
      const permissionId = permIds.get(g.key);
      if (!roleId || !permissionId) throw new SeedError(`Catalog row missing for ${r.key}/${g.key}`);
      return { roleId, permissionId, scope: g.scope };
    }),
  );
  const grantsCreated = rows.length ? (await tx.rolePermission.createMany({ data: rows, skipDuplicates: true })).count : 0;

  // Permissions created in THIS run: their catalog default grants also go to existing non-system roles.
  // Safe — no admin can have edited grants for a permission that did not exist until now — and without
  // it a new permission (e.g. academic.read) would reach SUPER_ADMIN only on an existing database.
  const newPermissionRows = newPermissionGrants(plan, missingPerms.map((p) => p.key), created).map((g) => {
    const roleId = roleIds.get(g.roleKey);
    const permissionId = permIds.get(g.key);
    if (!roleId || !permissionId) throw new SeedError(`Catalog row missing for ${g.roleKey}/${g.key}`);
    return { roleId, permissionId, scope: g.scope };
  });
  const newPermissionGrantsCreated = newPermissionRows.length ? (await tx.rolePermission.createMany({ data: newPermissionRows, skipDuplicates: true })).count : 0;

  // System roles: keep their scopes in line with the catalog.
  let grantScopesSynced = 0;
  for (const r of managed.filter((x) => x.isSystem)) {
    const want = new Map(r.grants.map((g) => [permIds.get(g.key)!, g.scope]));
    const have = await tx.rolePermission.findMany({ where: { roleId: roleIds.get(r.key)! }, select: { permissionId: true, scope: true } });
    for (const h of have) {
      const scope = want.get(h.permissionId);
      if (scope && scope !== h.scope) {
        await tx.rolePermission.update({ where: { roleId_permissionId: { roleId: roleIds.get(r.key)!, permissionId: h.permissionId } }, data: { scope } });
        grantScopesSynced++;
      }
    }
  }

  // Placeholder settings, only if absent.
  const hasSettings = (await tx.schoolSetting.count({ where: { id: "default" } })) > 0;
  if (!hasSettings) await tx.schoolSetting.create({ data: { id: "default", ...PLACEHOLDER_SETTINGS } });

  return {
    permissionsCreated: permsCreated,
    permissionsUpdated,
    rolesCreated: missingRoles.map((r) => r.key),
    grantsCreated,
    newPermissionGrantsCreated,
    grantScopesSynced,
    settingsCreated: !hasSettings,
    managedRoleKeys: managed.map((r) => r.key),
  };
}

export interface SeedSuperAdmin {
  username: string;
  /** Argon2id hash computed BEFORE the transaction (CPU work stays outside, backend rule). */
  passwordHash: string;
}

/** Must run after lockSuperAdminGuard(tx) in the same transaction. */
export async function ensureSuperAdmin(tx: Tx, input: SeedSuperAdmin): Promise<SuperAdminDecision & { userId?: string }> {
  const active = await activeSuperAdminIds(tx);
  const existing = await tx.user.findUnique({
    where: { username: input.username },
    select: { id: true, isActive: true, deletedAt: true, roles: { select: { role: { select: { key: true } } } } },
  });
  const decision = decideSuperAdmin({
    activeSuperAdminCount: active.length,
    existingUser: existing ? { isActive: existing.isActive, deleted: existing.deletedAt !== null, isSuperAdmin: existing.roles.some((r) => r.role.key === SUPER_ADMIN) } : null,
  });
  if (decision.action !== "create") return decision;

  const role = await tx.role.findUniqueOrThrow({ where: { key: SUPER_ADMIN }, select: { id: true } });
  const user = await tx.user.create({
    data: { username: input.username, displayName: "Super Admin", passwordHash: input.passwordHash, mustChangePassword: true, roles: { create: { roleId: role.id } } },
    select: { id: true },
  });
  await audit(tx, SEED_ACTOR, {
    action: "user.create",
    entityType: "User",
    entityId: user.id,
    after: { username: input.username, roleKeys: [SUPER_ADMIN], mustChangePassword: true, source: "seed" },
  });
  return { ...decision, userId: user.id };
}

/** Before commit: the catalog must be fully present, else throw (→ rollback). */
export async function verifySeed(tx: Tx, plan: SeedPlan, managedRoleKeys: string[]): Promise<void> {
  const problems: string[] = [];
  const permKeys = new Set((await tx.permission.findMany({ where: { key: { in: plan.permissions.map((p) => p.key) } }, select: { key: true } })).map((p) => p.key));
  if (permKeys.size !== plan.permissions.length) problems.push(`${plan.permissions.length - permKeys.size} catalog permission(s) missing`);
  const roles = await tx.role.findMany({
    where: { key: { in: plan.roles.map((r) => r.key) } },
    select: { key: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } },
  });
  if (roles.length !== plan.roles.length) problems.push(`${plan.roles.length - roles.length} catalog role(s) missing`);
  const managed = new Set(managedRoleKeys);
  for (const r of plan.roles) {
    const db = roles.find((x) => x.key === r.key);
    if (!db) continue;
    const have = new Set(db.permissions.map((p) => `${p.permission.key}:${p.scope}`));
    const want = new Set(r.grants.map((g) => `${g.key}:${g.scope}`));
    if (r.key === SUPER_ADMIN && plan.permissions.some((p) => !have.has(`${p.key}:ALL`))) problems.push("SUPER_ADMIN does not hold the whole catalog");
    if (managed.has(r.key) && (have.size !== want.size || [...want].some((g) => !have.has(g)))) problems.push(`role ${r.key} does not match its catalog grants`);
  }
  if (problems.length) throw new SeedError(`Seed verification failed — ${problems.join("; ")}. The transaction was rolled back; nothing was written.`);
}

export interface SeedTransactionOptions {
  plan: SeedPlan;
  superAdmin: SeedSuperAdmin | null;
  /** Re-checks the server identity INSIDE the transaction, after the lock and before any write. */
  verifyIdentity(tx: Tx): Promise<void>;
}
export interface SeedResult {
  stats: SeedStats;
  superAdmin: SuperAdminDecision | { action: "not-configured" };
}

/** The whole seed body; the caller supplies the transaction. */
export async function seedInTransaction(tx: Tx, opts: SeedTransactionOptions): Promise<SeedResult> {
  await lockSuperAdminGuard(tx); // FIRST statement of the transaction (rule 17)
  await opts.verifyIdentity(tx);
  const stats = await applySeed(tx, opts.plan);
  const superAdmin = opts.superAdmin ? await ensureSuperAdmin(tx, opts.superAdmin) : ({ action: "not-configured" } as const);
  await audit(tx, SEED_ACTOR, {
    action: "seed.apply",
    entityType: "Seed",
    entityId: "rbac-catalog",
    after: {
      permissionsCreated: stats.permissionsCreated,
      permissionsUpdated: stats.permissionsUpdated,
      rolesCreated: stats.rolesCreated.length,
      grantsCreated: stats.grantsCreated,
      newPermissionGrantsCreated: stats.newPermissionGrantsCreated,
      grantScopesSynced: stats.grantScopesSynced,
      settingsCreated: stats.settingsCreated,
      superAdmin: superAdmin.action,
    },
  });
  await verifySeed(tx, opts.plan, stats.managedRoleKeys);
  return { stats, superAdmin };
}

/** In-transaction identity query — same SQL as IDENTITY_SQL in db-target-guard. */
export async function queryIdentity(tx: Tx): Promise<DbIdentity> {
  const rows = await tx.$queryRaw<DbIdentity[]>`SELECT current_setting('neon.branch_id', true) AS branch, current_setting('neon.endpoint_id', true) AS endpoint`;
  return rows[0] ?? { branch: null, endpoint: null };
}

// ───────────────────────────── Guarded runner (ordering is unit-tested) ─────────────────────────────

export interface SeedRunnerDeps {
  /** process.env captured BEFORE any .env file is loaded. */
  shellEnv: Record<string, string | undefined>;
  /** Loads exactly <project>/.env and returns the resulting environment. */
  loadEnvFile(): Record<string, string | undefined>;
  /** Read-only session: the server's own identity. No writes. */
  preCheckIdentity(databaseUrl: string): Promise<DbIdentity>;
  hashPassword(password: string): Promise<string>;
  passwordProblem(password: string, username: string): string | null;
  /** Runs seedInTransaction inside ONE interactive transaction. */
  runTransaction(opts: SeedTransactionOptions): Promise<SeedResult>;
  log(line: string): void;
}

export async function runGuardedSeed(deps: SeedRunnerDeps): Promise<SeedResult> {
  assertShellClean(deps.shellEnv); // 1. before reading any file
  const env = deps.loadEnvFile();
  const target: SeedTarget = resolveSeedTarget(env); // 2–3. configuration + URL host, no connection
  deps.log("✓ target configuration: DATABASE_URL is the allow-listed endpoint, not forbidden, not test");

  let superAdmin: SeedSuperAdmin | null = null;
  const username = env.SEED_SUPERADMIN_USERNAME?.trim().toLowerCase();
  const password = env.SEED_SUPERADMIN_PASSWORD;
  if (username && password) {
    const problem = deps.passwordProblem(password, username);
    if (problem) throw new SeedError(`SEED_SUPERADMIN_PASSWORD rejected: ${problem} Nothing was written.`);
    superAdmin = { username, passwordHash: await deps.hashPassword(password) }; // CPU work before the transaction
  } else deps.log("• SEED_SUPERADMIN_USERNAME/PASSWORD not set — no Super Admin will be created");

  assertLiveIdentity(await deps.preCheckIdentity(env.DATABASE_URL!), target); // 4. read-only, before any write
  deps.log("✓ server identity: allow-listed development branch and endpoint (read-only check)");

  return deps.runTransaction({
    plan: planSeed(),
    superAdmin,
    verifyIdentity: async (tx) => assertLiveIdentity(await queryIdentity(tx), target),
  });
}
