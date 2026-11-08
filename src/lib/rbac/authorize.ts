import { ForbiddenError, UnauthenticatedError } from "@/lib/errors";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";

/** Widest first: a user holding ALL never needs a narrower check. */
const SCOPE_RANK: Record<Scope, number> = { ALL: 3, ASSIGNED: 2, CHILDREN: 1, SELF: 0 };

export interface AuthContext {
  userId: string;
  username: string;
  displayName: string;
  roleKeys: string[];
  isSuperAdmin: boolean;
  /** permission key → every scope granted to the user for it (union across roles) */
  permissions: Map<PermissionKey, Set<Scope>>;
  sessionId: string;
  mustChangePassword?: boolean;
  ipHash?: string;
  requestId?: string;
}

export interface GrantRow {
  roleKey: string;
  isSystem: boolean;
  permissionKey: string;
  scope: Scope;
}

/** Builds the permission map from the role grants loaded for a user. */
export function buildPermissionMap(rows: GrantRow[]): Map<PermissionKey, Set<Scope>> {
  const map = new Map<PermissionKey, Set<Scope>>();
  for (const row of rows) {
    const key = row.permissionKey as PermissionKey;
    const scopes = map.get(key) ?? new Set<Scope>();
    scopes.add(row.scope);
    map.set(key, scopes);
  }
  return map;
}

export function hasPermission(ctx: AuthContext | null | undefined, key: PermissionKey): boolean {
  if (!ctx || ctx.mustChangePassword) return false;
  return ctx.isSuperAdmin || ctx.permissions.has(key);
}

/** Widest scope the user holds for `key`, or null. */
export function scopeFor(ctx: AuthContext, key: PermissionKey): Scope | null {
  if (ctx.isSuperAdmin) return "ALL";
  const scopes = ctx.permissions.get(key);
  if (!scopes || scopes.size === 0) return null;
  return [...scopes].sort((a, b) => SCOPE_RANK[b] - SCOPE_RANK[a])[0];
}

/**
 * Server-side gate for every non-public service function. Returns the widest scope
 * so the caller's policy can narrow record access (ASSIGNED / SELF / CHILDREN).
 */
export function authorize(ctx: AuthContext | null | undefined, key: PermissionKey): Scope {
  if (!ctx) throw new UnauthenticatedError();
  // Defence in depth: a pending forced password change blocks every permissioned operation,
  // even if a page or action forgot to call requireAuth().
  if (ctx.mustChangePassword) throw new ForbiddenError("You must change your password before continuing.");
  const scope = scopeFor(ctx, key);
  if (!scope) throw new ForbiddenError();
  return scope;
}

/** For screens/actions that need one of several permissions. */
export function authorizeAny(ctx: AuthContext | null | undefined, keys: PermissionKey[]): PermissionKey {
  if (!ctx) throw new UnauthenticatedError();
  if (ctx.mustChangePassword) throw new ForbiddenError("You must change your password before continuing.");
  const granted = keys.find((k) => hasPermission(ctx, k));
  if (!granted) throw new ForbiddenError();
  return granted;
}
