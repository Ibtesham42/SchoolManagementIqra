import { accountKindOf } from "@/lib/rbac/account-kind";
import type { GrantRow, PortalContext } from "@/lib/rbac/authorize";
import { PORTAL_PERMISSION, portalScopeFor, type PortalChild, type PortalKind } from "@/lib/rbac/portal-scope";

/**
 * The permissions a portal account may ever use (ADR-045): the capability permissions, the UPI claim (P19) and the
 * student's own library record (catalog default). Adding a portal permission means adding it here (unit test).
 */
export const PORTAL_GRANT_ALLOWLIST: ReadonlySet<string> = new Set([...Object.values(PORTAL_PERMISSION), "fee.pay.online", "library.read"]);

/**
 * Review 6A-M2 L1 (defence in depth): a portal account's effective grants are only allowlisted permissions at its
 * own portal scope (CHILDREN for a guardian, SELF for a student). A PARENT / STUDENT role edited to hold more — an
 * ALL grant, a staff permission — gives nothing more on any surface (pages, actions, /api/v1 routes).
 */
export function portalGrantRows(rows: readonly GrantRow[], kind: PortalKind): GrantRow[] {
  const scope = portalScopeFor(kind);
  return rows.filter((r) => r.scope === scope && PORTAL_GRANT_ALLOWLIST.has(r.permissionKey));
}

/**
 * Phase 6A-M2 (ADR-044): turns the rows loaded with the session into `AuthContext.portal`. Pure — unit tested.
 * Fail closed: a portal role without a live person link gives a portal context with no children (the shell then
 * shows "no linked students"); a soft-deleted guardian or student gives none either.
 */
export interface LoadedStudent {
  id: string;
  status: string;
  deletedAt: Date | null;
  /** Newest status change first (at most one is needed). */
  statusChanges: { effectiveDate: Date }[];
}

export interface LoadedPortalUser {
  roleKeys: readonly string[];
  guardianId: string | null;
  studentId: string | null;
  guardian: { deletedAt: Date | null; students: { portalAccess: boolean; student: LoadedStudent }[] } | null;
  student: LoadedStudent | null;
}

/** At most this many children per guardian are resolved (a family never has more; bounds the session query). */
export const MAX_PORTAL_CHILDREN = 20;

const childOf = (s: LoadedStudent, portalAccess: boolean): PortalChild | null => {
  if (s.deletedAt) return null;
  const active = s.status === "ACTIVE";
  const leftOn = !active && s.statusChanges[0] ? s.statusChanges[0].effectiveDate.toISOString().slice(0, 10) : null;
  return { studentId: s.id, status: active ? "ACTIVE" : "LEFT", leftOn, portalAccess };
};

export function buildPortalContext(u: LoadedPortalUser): PortalContext | null {
  const kind = accountKindOf(u.roleKeys);
  if (kind === "STAFF") return null;
  if (kind === "GUARDIAN") {
    const live = u.guardianId && u.guardian && !u.guardian.deletedAt ? u.guardian.students : [];
    const children = live
      .map((l) => childOf(l.student, l.portalAccess))
      .filter((c): c is PortalChild => c !== null)
      .slice(0, MAX_PORTAL_CHILDREN);
    return { kind, guardianId: u.guardian && !u.guardian.deletedAt ? u.guardianId : null, studentId: null, children };
  }
  const own = u.studentId && u.student ? childOf(u.student, true) : null;
  return { kind, guardianId: null, studentId: own ? u.studentId : null, children: own ? [own] : [] };
}
