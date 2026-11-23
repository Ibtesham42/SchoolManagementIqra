import { NotFoundError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";
import { PORTAL_PERMISSION, portalCanSee, portalScopeFor, visibleChildren, type PortalCapability, type PortalChild, type PortalWindow } from "@/lib/rbac/portal-scope";

/**
 * Phase 6A-M2 (ADR-044): the record check every `*.portal.ts` read runs before it reads a student's data.
 *
 * Scope MEMBERSHIP, not the widest scope: a portal account passes only when its grants for the capability's
 * permission contain CHILDREN (guardian) or SELF (student). A staff or Super Admin context has no `portal` block and
 * never passes — staff screens use the staff services. Every refusal (not a portal account, missing student, a
 * sibling of another family, a blocked link, a leaver outside the window) is the same NotFoundError, so the
 * portal is no existence oracle.
 */
export const PORTAL_NOT_FOUND = "Not found.";

export function portalScopeOf(ctx: AuthContext): (key: PermissionKey) => Scope | null {
  const portal = ctx.portal;
  if (!portal || ctx.isSuperAdmin) return () => null;
  const wanted = portalScopeFor(portal.kind);
  return (key) => (ctx.permissions.get(key)?.has(wanted) ? wanted : null);
}

/** authorize → membership → child check. Throws NotFoundError unless this portal account may see the student. */
export function assertPortalStudent(ctx: AuthContext, studentId: string, capability: PortalCapability, window: PortalWindow): void {
  authorize(ctx, PORTAL_PERMISSION[capability]);
  if (!ctx.portal || !portalCanSee(ctx.portal, portalScopeOf(ctx), studentId, capability, window)) throw new NotFoundError(PORTAL_NOT_FOUND);
}

/** The children this portal account can still see at all (switcher, home). Empty for staff contexts. */
export function portalVisibleChildren(ctx: AuthContext, window: PortalWindow): PortalChild[] {
  if (!ctx.portal) return [];
  return visibleChildren(ctx.portal, portalScopeOf(ctx), window);
}
