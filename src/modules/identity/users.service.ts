import type { z } from "zod";
import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/temp-password";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { clearLoginLimits } from "./auth.service";
import { CLASS_TEACHER_ROLE_KEYS } from "@/modules/academic/academic.policy";
import { releaseClassTeacherAssignments } from "@/modules/academic/academic.tx";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";
import { PORTAL_ROLE_KEYS, accountKindOf } from "@/lib/rbac/account-kind";
import type { Prisma } from "@/generated/prisma/client";
import { activeSuperAdminIds, lockSuperAdminGuard } from "./super-admin-guard";
import {
  SUPER_ADMIN,
  actorCovers,
  assertCanAssignRoles,
  assertCanDeactivate,
  assertCanModifyUser,
  assertKeepsASuperAdmin,
  assertRolesMatchLinks,
  type RoleGrants,
  type TargetUser,
} from "./identity.policy";
import type { createUserSchema, listUsersSchema, updateUserSchema } from "./identity.schemas";

/** Fields safe to return to admin screens. Never includes the password hash. */
const SAFE_USER = {
  id: true,
  username: true,
  displayName: true,
  email: true,
  isActive: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  roles: { select: { role: { select: { key: true, name: true } } } },
} satisfies Prisma.UserSelect;

const isLocked = (lockedUntil: Date | null, now = Date.now()) => !!lockedUntil && lockedUntil.getTime() > now;

const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

export async function listUsers(ctx: AuthContext, input: z.infer<typeof listUsersSchema>) {
  authorize(ctx, "user.read");
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(input.status === "active" ? { isActive: true } : input.status === "inactive" ? { isActive: false } : {}),
    ...(input.q
      ? {
          OR: [
            { username: { contains: input.q, mode: "insensitive" } },
            { displayName: { contains: input.q, mode: "insensitive" } },
            { email: { contains: input.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      select: SAFE_USER,
      orderBy: [{ isActive: "desc" }, { displayName: "asc" }],
      skip: (input.page - 1) * input.pageSize,
      take: input.pageSize,
    }),
  ]);
  const now = Date.now();
  return { total, page: input.page, pageSize: input.pageSize, rows: rows.map((u) => ({ ...u, isLocked: isLocked(u.lockedUntil, now) })) };
}

export async function getUser(ctx: AuthContext, id: string) {
  authorize(ctx, "user.read");
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...SAFE_USER,
      _count: { select: { sessions: true } },
      roles: { select: { role: { select: { key: true, name: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } } } } },
    },
  });
  if (!user) throw new NotFoundError("User not found.");
  return {
    ...user,
    roles: user.roles.map((r) => ({ role: { key: r.role.key, name: r.role.name } })),
    permissions: user.roles.flatMap((r) => r.role.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope }))),
    isLocked: isLocked(user.lockedUntil),
  };
}

async function loadRoles(tx: Tx): Promise<Map<string, RoleGrants>> {
  const roles = await tx.role.findMany({
    select: { key: true, isSystem: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } },
  });
  return new Map(
    roles.map((r) => [
      r.key,
      { key: r.key, isSystem: r.isSystem, permissions: r.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope })) },
    ]),
  );
}

async function loadTarget(tx: Tx, id: string): Promise<TargetUser & { username: string }> {
  const u = await tx.user.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true,
      username: true,
      isActive: true,
      roles: { select: { role: { select: { key: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } } } } },
    },
  });
  if (!u) throw new NotFoundError("User not found.");
  return {
    id: u.id,
    username: u.username,
    isActive: u.isActive,
    roleKeys: u.roles.map((r) => r.role.key),
    permissions: u.roles.flatMap((r) => r.role.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope }))),
  };
}

async function setRoles(tx: Tx, userId: string, roleKeys: string[]) {
  const roles = await tx.role.findMany({ where: { key: { in: roleKeys } }, select: { id: true } });
  await tx.userRole.deleteMany({ where: { userId } });
  if (roles.length) await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id })) });
}

/** Returns the one-time temporary password; it is never stored or logged in plain text. */
export async function createUser(ctx: AuthContext, input: z.infer<typeof createUserSchema>) {
  authorize(ctx, "user.manage");
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  try {
    const user = await prisma.$transaction(async (tx) => {
      assertCanAssignRoles(ctx, null, input.roleKeys, await loadRoles(tx));
      const created = await tx.user.create({
        data: {
          username: input.username,
          displayName: input.displayName,
          email: input.email,
          passwordHash,
          mustChangePassword: true,
        },
        select: { id: true, username: true, displayName: true, email: true },
      });
      await setRoles(tx, created.id, input.roleKeys);
      await audit(tx, actorOf(ctx), { action: "user.create", entityType: "User", entityId: created.id, after: { ...created, roleKeys: input.roleKeys } });
      return created;
    });
    return { user, temporaryPassword };
  } catch (e) {
    if (isUniqueViolation(e, "username")) throw new ConflictError("That username is already taken.");
    if (isUniqueViolation(e, "email")) throw new ConflictError("That email address is already used by another account.");
    throw e;
  }
}

export async function updateUser(ctx: AuthContext, input: z.infer<typeof updateUserSchema>) {
  authorize(ctx, "user.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSuperAdminGuard(tx);
      // KI-066: lock the account row before replacing its roles, so a concurrent class-teacher assignment (which
      // holds the row FOR SHARE while it checks the teacher role) either finishes first — and is then released
      // below — or waits and sees the new roles. Lock order guard → user → sections, as elsewhere.
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${input.id} AND deleted_at IS NULL FOR UPDATE`;
      const target = await loadTarget(tx, input.id);
      assertCanModifyUser(ctx, target);
      assertCanAssignRoles(ctx, target, input.roleKeys, await loadRoles(tx));
      assertRolesMatchLinks(input.roleKeys, await tx.user.findUniqueOrThrow({ where: { id: target.id }, select: { employeeId: true, guardianId: true, studentId: true } }));
      if (target.roleKeys.includes(SUPER_ADMIN) && !input.roleKeys.includes(SUPER_ADMIN)) {
        assertKeepsASuperAdmin(await activeSuperAdminIds(tx), target.id, { isActive: target.isActive, isSuperAdmin: false });
      }
      const before = await tx.user.findUniqueOrThrow({ where: { id: target.id }, select: { displayName: true, email: true } });
      const after = await tx.user.update({
        where: { id: target.id },
        data: { displayName: input.displayName, email: input.email },
        select: { displayName: true, email: true },
      });
      await setRoles(tx, target.id, input.roleKeys);
      // S-09: losing every class-teacher-eligible role ends the user's class-teacher assignments (same transaction).
      if (!input.roleKeys.some((k) => (CLASS_TEACHER_ROLE_KEYS as readonly string[]).includes(k))) {
        await releaseClassTeacherAssignments(tx, actorOf(ctx), target.id);
      }
      // Permissions are loaded on every request, so role changes take effect immediately. Review 6A-M2 M1 (ADR-045):
      // a change of account kind (staff ↔ parent / student) also changes the session rules and the shell, so the
      // account's sessions end now (validateSessionToken also bounds staff sessions, as a second line).
      const kindChanged = accountKindOf(target.roleKeys) !== accountKindOf(input.roleKeys);
      const sessionsRevoked = kindChanged ? (await tx.session.deleteMany({ where: { userId: target.id } })).count : 0;
      await audit(tx, actorOf(ctx), {
        action: "user.update",
        entityType: "User",
        entityId: target.id,
        before: { ...before, roleKeys: target.roleKeys },
        after: { ...after, roleKeys: input.roleKeys, ...(kindChanged ? { sessionsRevoked } : {}) },
      });
      return { id: target.id };
    });
  } catch (e) {
    if (isUniqueViolation(e, "email")) throw new ConflictError("That email address is already used by another account.");
    throw e;
  }
}

export async function setUserActive(ctx: AuthContext, id: string, active: boolean) {
  authorize(ctx, "user.manage");
  await prisma.$transaction(async (tx) => {
    await lockSuperAdminGuard(tx);
    const target = await loadTarget(tx, id);
    if (active) assertCanModifyUser(ctx, target);
    else {
      assertCanDeactivate(ctx, target);
      if (target.roleKeys.includes(SUPER_ADMIN)) {
        assertKeepsASuperAdmin(await activeSuperAdminIds(tx), target.id, { isActive: false, isSuperAdmin: true });
      }
    }
    if (target.isActive === active) return;
    await tx.user.update({ where: { id }, data: { isActive: active, ...(active ? {} : { failedLoginCount: 0 }) } });
    if (!active) await tx.session.deleteMany({ where: { userId: id } });
    await audit(tx, actorOf(ctx), {
      action: active ? "user.reactivate" : "user.deactivate",
      entityType: "User",
      entityId: id,
      before: { isActive: target.isActive },
      after: { isActive: active },
    });
  });
}

/** Admin-issued temporary password (for users without email). Revokes all sessions and clears lockout. */
export async function adminResetPassword(ctx: AuthContext, id: string) {
  authorize(ctx, "user.manage");
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const username = await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    assertCanModifyUser(ctx, target);
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.passwordResetToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
    await audit(tx, actorOf(ctx), { action: "user.password_reset_by_admin", entityType: "User", entityId: id });
    return target.username;
  });
  await clearLoginLimits(username); // S-03: after commit
  return { temporaryPassword };
}

/** Clears the account lock AND (after commit) the user's login limiter buckets (S-03). */
export async function unlockUser(ctx: AuthContext, id: string) {
  authorize(ctx, "user.manage");
  const username = await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    assertCanModifyUser(ctx, target);
    await tx.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await audit(tx, actorOf(ctx), { action: "user.unlock", entityType: "User", entityId: id });
    return target.username;
  });
  await clearLoginLimits(username);
}

/** Sign a user out of every device. Users may always do this for themselves. */
export async function revokeUserSessions(ctx: AuthContext, id: string, opts: { keepCurrent?: boolean } = {}) {
  const self = id === ctx.userId;
  if (!self) authorize(ctx, "user.manage");
  return prisma.$transaction(async (tx) => {
    if (!self) assertCanModifyUser(ctx, await loadTarget(tx, id));
    const { count } = await tx.session.deleteMany({
      where: { userId: id, ...(self && opts.keepCurrent ? { id: { not: ctx.sessionId } } : {}) },
    });
    await audit(tx, actorOf(ctx), { action: "user.sessions_revoked", entityType: "User", entityId: id, after: { count, self } });
    return count;
  });
}

/**
 * Roles for the role picker, with `assignable` computed by the same policy the service enforces
 * (Super Admin role only for Super Admins; delegated admins only roles fully within their own permissions).
 */
export async function listAssignableRoles(ctx: AuthContext) {
  authorize(ctx, "user.read");
  const roles = await prisma.role.findMany({
    select: { key: true, name: true, description: true, isSystem: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } },
    orderBy: { name: "asc" },
  });
  return roles.map(({ permissions, ...r }) => ({
    ...r,
    assignable:
      ctx.isSuperAdmin ||
      (r.key !== SUPER_ADMIN && permissions.every((p) => actorCovers(ctx, p.permission.key as PermissionKey, p.scope as Scope))),
  }));
}

// ───────────────────────────── Employee account link (Phase 3A M3, H2) ─────────────────────────────
//
// User.employeeId is the optional one-to-one link from a login account to a staff record (ADR-036). Only
// these functions write it. The HR service calls the *Tx helpers inside its own transaction after locking
// the employee row (lock order: employee FOR UPDATE → user FOR UPDATE). Linking needs `user.manage` here
// (assertCanModifyUser: no linking accounts more privileged than the actor; only Super Admin touches a
// Super Admin) — the HR caller additionally authorizes `employee.manage`. No auto-linking by email (R2).

/** Locks the account row and returns it with its permissions (for the delegation check). */
async function lockAccount(tx: Tx, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "user" WHERE id = ${userId} AND deleted_at IS NULL FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("User not found.");
  const target = await loadTarget(tx, userId);
  const { employeeId } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { employeeId: true } });
  return { ...target, employeeId };
}

/**
 * Links `userId` to `employeeId` (the caller has locked the employee row and checked it has no account).
 *
 * SECURITY (KI-065; M3b, owner-approved 2026-11-18): the link gives the account SELF access to that employee's
 * record ("My profile", later payroll SELF). So (1) only a Super Admin may link their OWN account — anyone else
 * could otherwise attach themselves to a colleague's record (self-modification is exempt in assertCanModifyUser);
 * (2) the HR caller requires the linker to hold what SELF exposes (employee.read + employee.personal.read at ALL).
 */
export async function linkEmployeeAccountTx(tx: Tx, ctx: AuthContext, userId: string, employeeId: string): Promise<{ username: string }> {
  if (userId === ctx.userId && !ctx.isSuperAdmin) throw new ForbiddenError("You can't link your own account. Ask another administrator.");
  const target = await lockAccount(tx, userId);
  assertCanModifyUser(ctx, target);
  if (!target.isActive) throw new ValidationError("Choose an active account.", [{ path: "userId", message: "This account is deactivated." }]);
  // ADR-045: a parent / student portal account is never a staff account (the DB CHECK user_one_person covers links).
  assertRolesMatchLinks(target.roleKeys, { employeeId });
  if (target.employeeId === employeeId) return { username: target.username };
  if (target.employeeId) throw new ConflictError("This account is already linked to another employee. Unlink it there first.");
  try {
    await tx.user.update({ where: { id: userId }, data: { employeeId } });
  } catch (e) {
    if (isUniqueViolation(e, "employeeId")) throw new ConflictError("This employee already has a login account.");
    throw e;
  }
  await audit(tx, actorOf(ctx), { action: "user.employee_link", entityType: "User", entityId: userId, before: { employeeId: null }, after: { employeeId } });
  return { username: target.username };
}

/** Removes the link from the account linked to `employeeId`, if any (caller holds the employee row lock). */
export async function unlinkEmployeeAccountTx(tx: Tx, ctx: AuthContext, employeeId: string): Promise<{ userId: string } | null> {
  const linked = await tx.user.findFirst({ where: { employeeId }, select: { id: true, deletedAt: true } });
  if (!linked) return null;
  // Final review M1: unlinking your OWN account would switch off the "not your own record" checks (they rely on
  // the link) — refused like self-linking; a Super Admin or another administrator does it.
  if (linked.id === ctx.userId && !ctx.isSuperAdmin) throw new ForbiddenError("You can't unlink your own account. Ask another administrator.");
  if (linked.deletedAt) {
    // A soft-deleted account must not keep the employee from being relinked (review M3a L2). Removing a link
    // from an account nobody can use grants nothing, so the delegation check is not needed; still audited.
    await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${linked.id} FOR UPDATE`;
  } else {
    assertCanModifyUser(ctx, await lockAccount(tx, linked.id));
  }
  await tx.user.update({ where: { id: linked.id }, data: { employeeId: null } });
  await audit(tx, actorOf(ctx), { action: "user.employee_unlink", entityType: "User", entityId: linked.id, before: { employeeId }, after: { employeeId: null } });
  return { userId: linked.id };
}

/** Whether an account is already linked to this employee (inside the caller's transaction; no data returned). */
export async function employeeHasAccountTx(tx: Tx, employeeId: string): Promise<boolean> {
  return (await tx.user.count({ where: { employeeId } })) > 0;
}

/** The account linked to an employee, for the profile's "Login account" panel (`user.read`). */
export async function getLinkedAccount(ctx: AuthContext, employeeId: string) {
  authorize(ctx, "user.read");
  return prisma.user.findFirst({ where: { employeeId, deletedAt: null }, select: { id: true, username: true, displayName: true, isActive: true } });
}

/** Active accounts without an employee link, for the link picker (`user.manage`). Bounded — a school has few accounts. */
export async function listLinkableAccounts(ctx: AuthContext) {
  authorize(ctx, "user.manage");
  return prisma.user.findMany({
    // ADR-045: portal accounts (guardian / student links or a portal role) can't be linked to staff.
    where: { employeeId: null, guardianId: null, studentId: null, isActive: true, deletedAt: null, roles: { none: { role: { key: { in: [...PORTAL_ROLE_KEYS] } } } } },
    orderBy: { username: "asc" },
    take: 500,
    select: { id: true, username: true, displayName: true },
  });
}

/** The account linked to an employee (id only), inside the caller's transaction (no authorization here). */
export async function linkedAccountTx(tx: Tx, employeeId: string): Promise<{ id: string; isActive: boolean } | null> {
  return tx.user.findFirst({ where: { employeeId, deletedAt: null }, select: { id: true, isActive: true } });
}

/**
 * Deactivation inside the caller's transaction (Phase 3A M4a, H13: leaving an employee may deactivate their
 * login). The CALLER must run lockSuperAdminGuard(tx) as the first statement of its transaction (rule 17); this
 * function takes it again too (a transaction-scoped advisory lock is re-entrant), so a caller that forgot can't
 * race a concurrent Super Admin change (review M4a L2).
 * Same rules as setUserActive(false): user.manage + delegation check, not your own account, a Super Admin must
 * remain; sessions revoked; audited.
 */
export async function deactivateUserTx(tx: Tx, ctx: AuthContext, userId: string, reason: string): Promise<boolean> {
  authorize(ctx, "user.manage");
  await lockSuperAdminGuard(tx);
  await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${userId} FOR UPDATE`;
  const target = await loadTarget(tx, userId);
  assertCanDeactivate(ctx, target);
  if (target.roleKeys.includes(SUPER_ADMIN)) {
    assertKeepsASuperAdmin(await activeSuperAdminIds(tx), target.id, { isActive: false, isSuperAdmin: true });
  }
  if (!target.isActive) return false;
  await tx.user.update({ where: { id: userId }, data: { isActive: false, failedLoginCount: 0 } });
  await tx.session.deleteMany({ where: { userId } });
  await audit(tx, actorOf(ctx), { action: "user.deactivate", entityType: "User", entityId: userId, before: { isActive: true }, after: { isActive: false, reason } });
  return true;
}
