/**
 * Pure authorization rules for user and role administration (no I/O — unit tested).
 * Services call these inside their transactions with freshly loaded data.
 *
 * Super Admin protections (docs/AUTHENTICATION_AND_RBAC.md):
 *  - The SUPER_ADMIN role is a system role: its permissions, key and name are immutable; it can't be deleted.
 *  - Only a Super Admin may assign/remove the SUPER_ADMIN role or modify a Super Admin's account.
 *  - The last active Super Admin can't be deactivated or lose the role.
 * Anti-escalation (applies to any non–Super Admin holding user.manage / role.manage):
 *  - You can only assign roles / grant permissions you already hold, at the same or narrower scope.
 *  - You can only modify (edit, reset password, unlock, deactivate, sign out) users whose entire
 *    permission set you already hold — otherwise "reset their password, then sign in as them" escalates.
 *  - You can't edit a role you hold yourself.
 *
 * Scope ordering is a PARTIAL order: ALL covers everything; a scope covers itself; any scope covers
 * SELF. ASSIGNED (classes/routes) and CHILDREN (linked students) are different dimensions — neither
 * covers the other.
 */
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";

export const SUPER_ADMIN = "SUPER_ADMIN";

export interface RoleGrants {
  key: string;
  isSystem: boolean;
  permissions: { key: PermissionKey; scope: Scope }[];
}

export interface TargetUser {
  id: string;
  roleKeys: string[];
  isActive: boolean;
  /** The target's effective grants (union of their roles). Required for non–Super Admin actors. */
  permissions?: { key: PermissionKey; scope: Scope }[];
}

/** Partial order on scopes (see header). */
export function scopeCovers(held: Scope, wanted: Scope): boolean {
  return held === "ALL" || held === wanted || wanted === "SELF";
}

/** True when the actor holds `key` at a scope covering `scope` (Super Admin holds everything). */
export function actorCovers(ctx: AuthContext, key: PermissionKey, scope: Scope): boolean {
  if (ctx.isSuperAdmin) return !ctx.mustChangePassword;
  const held = ctx.permissions.get(key);
  if (!held || ctx.mustChangePassword) return false;
  return [...held].some((h) => scopeCovers(h, scope));
}

export function assertCanModifyUser(ctx: AuthContext, target: TargetUser): void {
  if (!hasPermission(ctx, "user.manage")) throw new ForbiddenError();
  if (ctx.isSuperAdmin) return;
  if (target.roleKeys.includes(SUPER_ADMIN)) {
    throw new ForbiddenError("Only a Super Admin can modify a Super Admin account.");
  }
  if (target.id === ctx.userId) return; // self-service on your own account doesn't escalate
  if (!target.permissions) throw new ForbiddenError("Target permissions not loaded."); // fail closed
  const beyond = target.permissions.find((p) => !actorCovers(ctx, p.key, p.scope));
  if (beyond) {
    throw new ForbiddenError("You can only manage accounts whose permissions you also hold. Ask a Super Admin.");
  }
}

/** Validates a proposed full role set for a user (create or update). */
export function assertCanAssignRoles(
  ctx: AuthContext,
  target: TargetUser | null,
  nextRoleKeys: string[],
  rolesByKey: Map<string, RoleGrants>,
): void {
  if (!hasPermission(ctx, "user.manage")) throw new ForbiddenError();
  for (const key of nextRoleKeys) {
    if (!rolesByKey.has(key)) throw new ValidationError(`Unknown role: ${key}`, [{ path: "roleKeys", message: "Unknown role." }]);
  }
  const before = new Set(target?.roleKeys ?? []);
  const after = new Set(nextRoleKeys);
  const added = [...after].filter((k) => !before.has(k));
  const removed = [...before].filter((k) => !after.has(k));

  if ((added.includes(SUPER_ADMIN) || removed.includes(SUPER_ADMIN)) && !ctx.isSuperAdmin) {
    throw new ForbiddenError("Only a Super Admin can assign or remove the Super Admin role.");
  }
  if (target && target.id === ctx.userId && removed.includes(SUPER_ADMIN)) {
    throw new ForbiddenError("You cannot remove the Super Admin role from your own account.");
  }
  if (!ctx.isSuperAdmin) {
    for (const key of [...added, ...removed]) {
      const role = rolesByKey.get(key);
      if (!role) continue;
      const beyond = role.permissions.find((p) => !actorCovers(ctx, p.key, p.scope));
      if (beyond) {
        throw new ForbiddenError(`You cannot assign or remove the role "${key}": it grants permissions you do not hold.`);
      }
    }
  }
}

export function assertCanDeactivate(ctx: AuthContext, target: TargetUser): void {
  assertCanModifyUser(ctx, target);
  if (target.id === ctx.userId) throw new ForbiddenError("You cannot deactivate your own account.");
}

/**
 * After a change, at least one active user must still hold SUPER_ADMIN.
 * `activeSuperAdminIds` = active Super Admins before the change.
 */
export function assertKeepsASuperAdmin(
  activeSuperAdminIds: string[],
  targetId: string,
  after: { isActive: boolean; isSuperAdmin: boolean },
): void {
  const remaining = activeSuperAdminIds.filter((id) => id !== targetId);
  if (after.isActive && after.isSuperAdmin) remaining.push(targetId);
  if (remaining.length === 0) throw new ForbiddenError("At least one active Super Admin must remain.");
}

// ───────────────────────────── Roles ─────────────────────────────

export const ROLE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{2,39}$/;

export function assertCanEditRole(ctx: AuthContext, role: { key: string; isSystem: boolean }): void {
  if (!hasPermission(ctx, "role.manage")) throw new ForbiddenError();
  if (role.isSystem || role.key === SUPER_ADMIN) throw new ForbiddenError("System roles cannot be modified.");
  if (!ctx.isSuperAdmin && ctx.roleKeys.includes(role.key)) {
    throw new ForbiddenError("You cannot edit a role you hold yourself.");
  }
}

/** Grants a non–Super Admin may set: only what they hold, at the same or narrower scope. */
export function assertGrantsWithinActor(
  ctx: AuthContext,
  current: { key: PermissionKey; scope: Scope }[],
  next: { key: PermissionKey; scope: Scope }[],
): void {
  if (ctx.isSuperAdmin) return;
  const cur = new Map(current.map((g) => [g.key, g.scope]));
  const nxt = new Map(next.map((g) => [g.key, g.scope]));
  const changed = new Set<PermissionKey>([...cur.keys(), ...nxt.keys()].filter((k) => cur.get(k) !== nxt.get(k)));
  for (const key of changed) {
    const scope = nxt.get(key) ?? cur.get(key)!;
    if (!actorCovers(ctx, key, scope)) {
      throw new ForbiddenError(`You cannot grant or revoke "${key}" because you do not hold it at that scope.`);
    }
  }
}

export function assertCanDeleteRole(ctx: AuthContext, role: { key: string; isSystem: boolean; userCount: number }): void {
  assertCanEditRole(ctx, role);
  if (role.userCount > 0) throw new ForbiddenError("Remove this role from all users before deleting it.");
}

export function assertValidNewRoleKey(key: string, existing: Set<string>): void {
  if (!ROLE_KEY_PATTERN.test(key)) {
    throw new ValidationError("Use 3–40 capital letters, digits or underscores, starting with a letter.", [
      { path: "key", message: "Invalid key." },
    ]);
  }
  if (key === SUPER_ADMIN || existing.has(key)) {
    throw new ValidationError("A role with this key already exists.", [{ path: "key", message: "Already exists." }]);
  }
}
