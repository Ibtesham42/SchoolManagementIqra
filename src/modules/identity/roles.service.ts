import type { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/db-errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";
import {
  assertCanDeleteRole,
  assertCanEditRole,
  assertGrantsWithinActor,
  assertValidNewRoleKey,
} from "./identity.policy";
import type { createRoleSchema, setRolePermissionsSchema, updateRoleSchema } from "./identity.schemas";

const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });

export async function listRoles(ctx: AuthContext) {
  authorize(ctx, "role.manage");
  const roles = await prisma.role.findMany({
    select: { id: true, key: true, name: true, description: true, isSystem: true, _count: { select: { users: true, permissions: true } } },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
  });
  return roles;
}

export async function getRole(ctx: AuthContext, id: string) {
  authorize(ctx, "role.manage");
  const role = await prisma.role.findUnique({
    where: { id },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      isSystem: true,
      _count: { select: { users: true } },
      permissions: { select: { scope: true, permission: { select: { key: true } } } },
    },
  });
  if (!role) throw new NotFoundError("Role not found.");
  return {
    ...role,
    grants: role.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope })),
  };
}

export async function createRole(ctx: AuthContext, input: z.infer<typeof createRoleSchema>) {
  authorize(ctx, "role.manage");
  try {
    return await createRoleTx(ctx, input);
  } catch (e) {
    // Two admins creating the same key at once: the unique index decides; report it clearly.
    if (isUniqueViolation(e, "key")) throw new ValidationError("A role with this key already exists.", [{ path: "key", message: "Already exists." }]);
    throw e;
  }
}

async function createRoleTx(ctx: AuthContext, input: z.infer<typeof createRoleSchema>) {
  return prisma.$transaction(async (tx) => {
    const existing = new Set((await tx.role.findMany({ select: { key: true } })).map((r) => r.key));
    assertValidNewRoleKey(input.key, existing);
    const role = await tx.role.create({
      data: { key: input.key, name: input.name, description: input.description || null, isSystem: false },
      select: { id: true, key: true, name: true },
    });
    await audit(tx, actorOf(ctx), { action: "role.create", entityType: "Role", entityId: role.id, after: role });
    return role;
  });
}

export async function updateRole(ctx: AuthContext, input: z.infer<typeof updateRoleSchema>) {
  authorize(ctx, "role.manage");
  await prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({ where: { id: input.id }, select: { key: true, isSystem: true, name: true, description: true } });
    if (!role) throw new NotFoundError("Role not found.");
    assertCanEditRole(ctx, role);
    await tx.role.update({ where: { id: input.id }, data: { name: input.name, description: input.description || null } });
    await audit(tx, actorOf(ctx), {
      action: "role.update",
      entityType: "Role",
      entityId: input.id,
      before: { name: role.name, description: role.description },
      after: { name: input.name, description: input.description },
    });
  });
}

/** Replaces the role's full permission set. Changes apply to all holders on their next request. */
export async function setRolePermissions(ctx: AuthContext, input: z.infer<typeof setRolePermissionsSchema>) {
  authorize(ctx, "role.manage");
  await prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({
      where: { id: input.id },
      select: { key: true, isSystem: true, permissions: { select: { scope: true, permission: { select: { key: true } } } } },
    });
    if (!role) throw new NotFoundError("Role not found.");
    assertCanEditRole(ctx, role);
    const current = role.permissions.map((p) => ({ key: p.permission.key as PermissionKey, scope: p.scope as Scope }));
    assertGrantsWithinActor(ctx, current, input.grants);

    const ids = new Map(
      (await tx.permission.findMany({ where: { key: { in: input.grants.map((g) => g.key) } }, select: { id: true, key: true } })).map(
        (p) => [p.key, p.id],
      ),
    );
    await tx.rolePermission.deleteMany({ where: { roleId: input.id } });
    if (input.grants.length) {
      await tx.rolePermission.createMany({
        data: input.grants.map((g) => {
          const permissionId = ids.get(g.key);
          if (!permissionId) throw new NotFoundError(`Permission ${g.key} is not seeded.`);
          return { roleId: input.id, permissionId, scope: g.scope };
        }),
      });
    }
    await audit(tx, actorOf(ctx), { action: "role.permissions_set", entityType: "Role", entityId: input.id, before: current, after: input.grants });
  });
}

export async function deleteRole(ctx: AuthContext, id: string) {
  authorize(ctx, "role.manage");
  await prisma.$transaction(async (tx) => {
    const role = await tx.role.findUnique({ where: { id }, select: { key: true, isSystem: true, name: true, _count: { select: { users: true } } } });
    if (!role) throw new NotFoundError("Role not found.");
    assertCanDeleteRole(ctx, { key: role.key, isSystem: role.isSystem, userCount: role._count.users });
    await tx.role.delete({ where: { id } }); // role_permission rows cascade
    await audit(tx, actorOf(ctx), { action: "role.delete", entityType: "Role", entityId: id, before: { key: role.key, name: role.name } });
  });
}
