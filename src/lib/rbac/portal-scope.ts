import type { PermissionKey, Scope } from "./catalog";

/**
 * Phase 6A — what a portal account may see about one student (PHASE_6_PLAN.md P9–P17, P24; ADR-045). Pure — the
 * truth table is unit tested. Every portal read service calls `portalCanSee` for the student it is about to read
 * (after `authorize`), with the account's resolved family from the AuthContext; anything not allowed is NotFound.
 *
 * - A GUARDIAN account sees its linked children (StudentGuardian), except where the office blocked the link
 *   (portalAccess = false, P24). A STUDENT account sees only itself (P14), and never fees.
 * - The permission behind each capability must be held at CHILDREN (guardian) or SELF (student) — never ALL or
 *   ASSIGNED for a portal account (catalog invariant).
 * - A child who LEFT (status change or enrollment LEFT) stays visible for report cards and receipts only, for
 *   `leaverAccessDays` from the leaving date (P17; 0 = none). No attendance / homework / timetable after leaving.
 */
export type PortalKind = "GUARDIAN" | "STUDENT";
export type PortalCapability = "profile" | "attendance" | "timetable" | "calendar" | "homework" | "results" | "fees" | "notices";

export interface PortalChild {
  studentId: string;
  /** "ACTIVE" while studying; "LEFT" once the student left the school (leftOn = school-local date). */
  status: "ACTIVE" | "LEFT";
  leftOn: string | null;
  /** P24: false = blocked for this guardian. Always true for a student's own account. */
  portalAccess: boolean;
}

export interface PortalFamily {
  kind: PortalKind;
  children: readonly PortalChild[];
}

/** The permission each capability rests on. */
export const PORTAL_PERMISSION: Record<PortalCapability, PermissionKey> = {
  profile: "student.read",
  attendance: "attendance.student.read",
  timetable: "timetable.read",
  calendar: "timetable.read",
  homework: "homework.read",
  results: "result.read",
  fees: "fee.read",
  notices: "notice.read",
};

/** Capabilities a leaver keeps within the access window (P17). */
const LEAVER_CAPABILITIES: ReadonlySet<PortalCapability> = new Set(["results", "fees"]);

export const portalScopeFor = (kind: PortalKind): Scope => (kind === "GUARDIAN" ? "CHILDREN" : "SELF");

const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

export interface PortalWindow {
  /** School-local today (YYYY-MM-DD). */
  today: string;
  leaverAccessDays: number;
}

/** May this portal family see `studentId` for `capability`? `scopeOf` = the account's scope for a permission. */
export function portalCanSee(family: PortalFamily, scopeOf: (key: PermissionKey) => Scope | null, studentId: string, capability: PortalCapability, window: PortalWindow): boolean {
  if (scopeOf(PORTAL_PERMISSION[capability]) !== portalScopeFor(family.kind)) return false;
  if (family.kind === "STUDENT" && capability === "fees") return false;
  const child = family.children.find((c) => c.studentId === studentId);
  if (!child || !child.portalAccess) return false;
  if (child.status === "ACTIVE") return true;
  if (!child.leftOn || window.leaverAccessDays <= 0 || !LEAVER_CAPABILITIES.has(capability)) return false;
  const since = daysBetween(child.leftOn, window.today);
  return since >= 0 && since <= window.leaverAccessDays;
}

/** The children this family can still see at all (for the child switcher and "no children" screens). */
export function visibleChildren(family: PortalFamily, scopeOf: (key: PermissionKey) => Scope | null, window: PortalWindow): PortalChild[] {
  return family.children.filter((c) => portalCanSee(family, scopeOf, c.studentId, "profile", window) || portalCanSee(family, scopeOf, c.studentId, "results", window));
}
