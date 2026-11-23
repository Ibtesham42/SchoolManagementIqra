/**
 * Phase 6A-M2 — portal navigation items. Pure (unit tested). Only /portal links: the portal shell never offers an
 * ERP destination (ADR-045; static guard test). Child pages carry the child in the URL — untrusted input, every
 * page re-checks access through the service.
 */
export type PortalNavIcon = "home" | "profile" | "account";
export interface PortalNavItem {
  href: string;
  label: string;
  icon: PortalNavIcon;
}

/** The selected child, from `/portal/c/<id>/…`, only when it is one of the account's visible children. */
export function childIdFromPath(pathname: string, childIds: readonly string[]): string | null {
  const m = /^\/portal\/c\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return childIds.includes(id) ? id : null;
}

export function portalNavItems(childId: string | null): PortalNavItem[] {
  const items: PortalNavItem[] = [{ href: "/portal", label: "Home", icon: "home" }];
  if (childId) items.push({ href: `/portal/c/${encodeURIComponent(childId)}/profile`, label: "Profile", icon: "profile" });
  items.push({ href: "/portal/account", label: "Account", icon: "account" });
  return items;
}
