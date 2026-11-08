import type { z } from "zod";
import { prisma, type Tx } from "@/lib/db";
import { audit } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/password";
import { generateTemporaryPassword } from "@/lib/auth/temp-password";
import { isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";
import type { Prisma } from "@/generated/prisma/client";
import {
  SUPER_ADMIN,
  actorCovers,
  assertCanAssignRoles,
  assertCanDeactivate,
  assertCanModifyUser,
  assertKeepsASuperAdmin,
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

/**
 * Serializes every operation that can change who is an active Super Admin.
 * A transaction-scoped advisory lock (released at commit/rollback; works through Neon's
 * transaction-mode pooler). Row locks on a JOIN are NOT enough under READ COMMITTED: a blocked
 * `SELECT … FOR UPDATE` re-checks only the locked rows, while joined rows (user_role) come from the
 * old snapshot — so "remove A's role" racing "deactivate B" could leave zero Super Admins.
 * Must be the FIRST statement of the transaction, before any reads it depends on.
 */
async function lockSuperAdminGuard(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.super_admin_guard'))) AS l`;
}

/** Read AFTER lockSuperAdminGuard(): each READ COMMITTED statement sees all prior commits. */
async function activeSuperAdminIds(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT u.id FROM "user" u
    JOIN user_role ur ON ur.user_id = u.id
    JOIN role r ON r.id = ur.role_id
    WHERE r.key = ${SUPER_ADMIN} AND u.is_active AND u.deleted_at IS NULL`;
  return rows.map((r) => r.id);
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
      const target = await loadTarget(tx, input.id);
      assertCanModifyUser(ctx, target);
      assertCanAssignRoles(ctx, target, input.roleKeys, await loadRoles(tx));
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
      // Permissions are loaded on every request, so role changes take effect immediately — no session revocation needed.
      await audit(tx, actorOf(ctx), {
        action: "user.update",
        entityType: "User",
        entityId: target.id,
        before: { ...before, roleKeys: target.roleKeys },
        after: { ...after, roleKeys: input.roleKeys },
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
  await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    assertCanModifyUser(ctx, target);
    await tx.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
    });
    await tx.session.deleteMany({ where: { userId: id } });
    await tx.passwordResetToken.updateMany({ where: { userId: id, usedAt: null }, data: { usedAt: new Date() } });
    await audit(tx, actorOf(ctx), { action: "user.password_reset_by_admin", entityType: "User", entityId: id });
  });
  return { temporaryPassword };
}

export async function unlockUser(ctx: AuthContext, id: string) {
  authorize(ctx, "user.manage");
  await prisma.$transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    assertCanModifyUser(ctx, target);
    await tx.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
    await audit(tx, actorOf(ctx), { action: "user.unlock", entityType: "User", entityId: id });
  });
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
