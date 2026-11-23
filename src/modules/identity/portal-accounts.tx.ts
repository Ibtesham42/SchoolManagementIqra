import type { prisma, Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { ACTIVATION_TTL_DAYS, UNUSABLE_PASSWORD_HASH, generateActivationCode, hashActivationCode } from "@/lib/auth/activation-code";
import { PORTAL_GRANT_ALLOWLIST } from "@/lib/auth/portal-context";
import { accountKindOf, type AccountKind } from "@/lib/rbac/account-kind";
import { portalScopeFor } from "@/lib/rbac/portal-scope";

/**
 * Phase 6A-M3 (ADR-046) — portal account helpers inside the CALLER's transaction. The students module calls them
 * under its own locks (student → guardian(s) ORDER BY id → user), after it authorized `portal.account.manage`.
 * Identity never imports students (no cycle). Every helper re-checks that the account is portal-only, so this path
 * can never touch a staff or Super Admin account (the delegation rules of /erp/users don't apply here).
 *
 * Codes leave only as the return value of `issueActivationCodeTx` (printed once on the slip); audit rows never
 * hold a code, a date of birth or a password.
 */
type PortalRole = "PARENT" | "STUDENT";
const ROLE_OF: Record<Exclude<AccountKind, "STAFF">, PortalRole> = { GUARDIAN: "PARENT", STUDENT: "STUDENT" };

/**
 * Before every provisioning: the PARENT / STUDENT role must still hold only portal grants at its portal scope. A
 * role edited to hold more must never turn bulk provisioning into privilege escalation (PHASE_6_PLAN.md §2.4).
 */
export async function assertPortalRoleAllowlistTx(tx: Tx, kind: Exclude<AccountKind, "STAFF">): Promise<{ roleId: string }> {
  const role = await tx.role.findUnique({
    where: { key: ROLE_OF[kind] },
    select: { id: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } },
  });
  if (!role) throw new ForbiddenError(`The ${ROLE_OF[kind] === "PARENT" ? "Parent" : "Student"} role is missing. Ask a Super Admin.`);
  const scope = portalScopeFor(kind);
  const beyond = role.permissions.find((p) => p.scope !== scope || !PORTAL_GRANT_ALLOWLIST.has(p.permission.key));
  if (beyond) throw new ForbiddenError("The portal role was changed to hold more than portal access. Ask a Super Admin to restore it before issuing accounts.");
  return { roleId: role.id };
}

export interface PortalAccountRow {
  id: string;
  username: string;
  isActive: boolean;
  activatedAt: Date | null;
  /** Expiry of the newest usable code, if any. */
  pendingCodeExpiresAt: Date | null;
  /**
   * Review 6A-M3b M1: the account was activated at least once (a password was set by activation, which an office
   * reset never clears). Such an account is never re-opened by email, even while a reset leaves it "slip issued".
   */
  everActivated: boolean;
}

/** The account linked to a guardian (or student), if any — no authorization here; the caller authorized. */
export async function portalAccountOfTx(tx: Tx, link: { guardianId: string } | { studentId: string }): Promise<PortalAccountRow | null> {
  const u = await tx.user.findFirst({
    where: { ...link, deletedAt: null },
    select: {
      id: true,
      username: true,
      isActive: true,
      privacyConsentAt: true,
      passwordChangedAt: true,
      activations: { where: { usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 1, select: { expiresAt: true } },
    },
  });
  return u ? { id: u.id, username: u.username, isActive: u.isActive, activatedAt: u.privacyConsentAt, pendingCodeExpiresAt: u.activations[0]?.expiresAt ?? null, everActivated: u.passwordChangedAt !== null } : null;
}

/** Accounts linked to many guardians at once (section lists); inside a transaction or with the global client (reads). */
export async function portalAccountsOfGuardiansTx(tx: Tx | typeof prisma, guardianIds: string[]): Promise<Map<string, PortalAccountRow>> {
  if (guardianIds.length === 0) return new Map();
  const rows = await tx.user.findMany({
    where: { guardianId: { in: guardianIds }, deletedAt: null },
    take: guardianIds.length,
    select: {
      id: true,
      guardianId: true,
      username: true,
      isActive: true,
      privacyConsentAt: true,
      passwordChangedAt: true,
      activations: { where: { usedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" }, take: 1, select: { expiresAt: true } },
    },
  });
  return new Map(rows.map((u) => [u.guardianId!, { id: u.id, username: u.username, isActive: u.isActive, activatedAt: u.privacyConsentAt, pendingCodeExpiresAt: u.activations[0]?.expiresAt ?? null, everActivated: u.passwordChangedAt !== null }]));
}

/** Is this username free (any account, active or not)? Never says whose it is. */
export async function usernameTakenTx(tx: Tx, username: string): Promise<boolean> {
  return (await tx.user.count({ where: { username } })) > 0;
}

/**
 * Creates a portal-only account (no usable password until activation) for a guardian or a student. The caller holds
 * the person's row lock and checked it has no account. Username collision → ValidationError on `username`, without saying whose it is.
 */
export async function createPortalAccountTx(
  tx: Tx,
  actor: AuditActor,
  input: { kind: Exclude<AccountKind, "STAFF">; guardianId?: string; studentId?: string; username: string; displayName: string },
): Promise<{ userId: string; username: string }> {
  const { roleId } = await assertPortalRoleAllowlistTx(tx, input.kind);
  const link = input.kind === "GUARDIAN" ? { guardianId: input.guardianId } : { studentId: input.studentId };
  if (!link.guardianId && !link.studentId) throw new NotFoundError("Person not found.");
  let created: { id: string; username: string };
  try {
    created = await tx.user.create({
      data: { username: input.username, displayName: input.displayName, passwordHash: UNUSABLE_PASSWORD_HASH, mustChangePassword: false, ...link, roles: { create: { roleId } } },
      select: { id: true, username: true },
    });
  } catch (e) {
    if (isUniqueViolation(e, "username")) throw new ValidationError("That username is already taken. Choose another one.", [{ path: "username", message: "Already taken." }]);
    if (isUniqueViolation(e, "guardianId") || isUniqueViolation(e, "studentId")) throw new ConflictError("This person already has a portal account.");
    throw e;
  }
  await audit(tx, actor, { action: "portal.account_create", entityType: "User", entityId: created.id, after: { username: created.username, kind: input.kind, ...link } });
  return { userId: created.id, username: created.username };
}

/** Locks a portal-only account; refuses staff accounts with the same NotFound as a missing one. */
async function lockPortalAccount(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "user" WHERE id = ${userId} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Account not found.");
  const u = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, username: true, isActive: true, guardianId: true, studentId: true, employeeId: true, roles: { select: { role: { select: { key: true } } } } },
  });
  const kind = accountKindOf(u.roles.map((r) => r.role.key));
  if (kind === "STAFF" || u.employeeId || (!u.guardianId && !u.studentId)) throw new NotFoundError("Account not found.");
  return { ...u, kind };
}

/**
 * Issues a new activation code (the only one that works from now on). `reset` (office "print a new slip" for an
 * account that may already be in use): the password stops working, every session and pending reset link ends.
 * Returns the code ONCE for the slip.
 */
export async function issueActivationCodeTx(tx: Tx, actor: AuditActor, userId: string, opts: { reset: boolean; channel?: "SLIP" | "EMAIL" }): Promise<{ code: string; expiresAt: Date; username: string }> {
  const account = await lockPortalAccount(tx, userId);
  await assertPortalRoleAllowlistTx(tx, account.kind);
  if (!account.isActive) throw new ConflictError("This portal account is deactivated. Reactivate it first.");
  const now = new Date();
  await tx.accountActivation.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  if (opts.reset) {
    // Consent is recorded again at the next activation; until then the account shows as "slip issued".
    await tx.user.update({ where: { id: userId }, data: { passwordHash: UNUSABLE_PASSWORD_HASH, failedLoginCount: 0, lockedUntil: null, privacyConsentAt: null, privacyConsentVersion: null } });
    await tx.session.deleteMany({ where: { userId } });
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: now } });
  }
  const code = generateActivationCode();
  const expiresAt = new Date(now.getTime() + ACTIVATION_TTL_DAYS * 86_400_000);
  await tx.accountActivation.create({ data: { userId, codeHash: hashActivationCode(code), channel: opts.channel ?? "SLIP", expiresAt, createdById: actor.userId } });
  await audit(tx, actor, { action: opts.reset ? "portal.account_reset" : "portal.code_issued", entityType: "User", entityId: userId, after: { channel: opts.channel ?? "SLIP", expiresAt: expiresAt.toISOString() } });
  return { code, expiresAt, username: account.username };
}

/** Deactivate / reactivate a portal-only account (deactivation ends sessions and voids codes). Returns whether it changed. */
export async function setPortalAccountActiveTx(tx: Tx, actor: AuditActor, userId: string, active: boolean, reason: string): Promise<boolean> {
  const account = await lockPortalAccount(tx, userId);
  if (account.isActive === active) return false;
  await tx.user.update({ where: { id: userId }, data: { isActive: active, failedLoginCount: 0, lockedUntil: null } });
  if (!active) {
    await tx.session.deleteMany({ where: { userId } });
    await tx.accountActivation.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
  }
  await audit(tx, actor, { action: active ? "portal.account_reactivate" : "portal.account_deactivate", entityType: "User", entityId: userId, before: { isActive: !active }, after: { isActive: active, reason } });
  return true;
}
