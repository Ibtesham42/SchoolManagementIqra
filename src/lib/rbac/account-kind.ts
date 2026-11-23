/**
 * Phase 6A-M2 — account kinds (ADR-045). Pure — unit tested.
 *
 * A portal account holds exactly one role, PARENT or STUDENT, and nothing else. Every other role set is a staff
 * account. A mixed set (a portal role together with any other role) is refused by identity on create / update; one
 * that already exists is treated as STAFF, so it never gets the 30-day session or the portal shell, and its
 * CHILDREN / SELF grants stay unused (staff services refuse those scopes).
 */
export const PORTAL_ROLE_KEYS = ["PARENT", "STUDENT"] as const;
export type AccountKind = "STAFF" | "GUARDIAN" | "STUDENT";

const isPortalRole = (key: string) => (PORTAL_ROLE_KEYS as readonly string[]).includes(key);

export function accountKindOf(roleKeys: readonly string[]): AccountKind {
  if (roleKeys.length !== 1) return "STAFF";
  if (roleKeys[0] === "PARENT") return "GUARDIAN";
  if (roleKeys[0] === "STUDENT") return "STUDENT";
  return "STAFF";
}

export const isPortalKind = (kind: AccountKind) => kind !== "STAFF";

/** Why this role set is not allowed (ADR-045), or null. */
export function portalRoleSetProblem(roleKeys: readonly string[]): string | null {
  const unique = new Set(roleKeys);
  const portal = [...unique].filter(isPortalRole);
  if (portal.length === 0) return null;
  if (unique.size > 1) return "The Parent and Student roles can't be combined with any other role. Staff who are also parents get a separate parent account.";
  return null;
}

/**
 * Why an account with these person links may not hold this role set, or null. A guardian / student link means a
 * portal account (exactly PARENT / STUDENT); an employee link means a staff account (no portal role).
 */
export function accountLinkProblem(roleKeys: readonly string[], links: { employeeId?: string | null; guardianId?: string | null; studentId?: string | null }): string | null {
  const kind = accountKindOf(roleKeys);
  const hasPortalRole = roleKeys.some(isPortalRole);
  if (links.guardianId && kind !== "GUARDIAN") return "This account belongs to a parent or guardian: it can hold only the Parent role.";
  if (links.studentId && kind !== "STUDENT") return "This account belongs to a student: it can hold only the Student role.";
  if (links.employeeId && hasPortalRole) return "A staff account can't hold the Parent or Student role. Create a separate parent account.";
  return null;
}

/** Where a signed-in account lands (login, `/login` while signed in, the wrong shell). */
export function homePathFor(kind: AccountKind, mustChangePassword: boolean): string {
  if (isPortalKind(kind)) return mustChangePassword ? "/portal/change-password" : "/portal";
  return mustChangePassword ? "/erp/change-password" : "/erp";
}

/** "Keep me signed in" gives the long session only to portal-only accounts (ADR-045); staff always get 8 h. */
export const longSessionAllowed = (roleKeys: readonly string[], remember: boolean) => remember && isPortalKind(accountKindOf(roleKeys));
