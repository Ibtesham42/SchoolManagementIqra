import { NotFoundError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";

/**
 * Pure access rules for staff records (no I/O — unit tested). ADR-036, PHASE_3_PLAN.md §5.3, H6/H7.
 *
 * Two data tiers (H6): the **directory** (`employee.read`) and **personal** details (`employee.personal.read`).
 * Both are served at ALL scope only in M2. SELF ("my profile", H7) needs the AuthContext employee link,
 * which arrives in M3 with its own approval; until then a SELF grant gives no access (fail closed) — and the
 * catalog grants SELF to no role yet, so the role editor can't offer it (ALLOWED_SCOPES, S-08).
 */
export type EmployeeTier = "directory" | "personal";

/** Directory access (list, profile header). Throws Forbidden without `employee.read`; NotFound-like for SELF. */
export function employeeReadAccess(ctx: AuthContext): { tier: EmployeeTier } {
  const scope = authorize(ctx, "employee.read");
  if (scope !== "ALL") throw new NotFoundError("Employee not found.");
  return { tier: canReadPersonal(ctx) ? "personal" : "directory" };
}

export function canReadPersonal(ctx: AuthContext): boolean {
  return hasPermission(ctx, "employee.personal.read") && scopeFor(ctx, "employee.personal.read") === "ALL";
}

/** Can this user use the staff directory at all? (Pages show NotPermitted instead of an error.) */
export function canBrowseEmployees(ctx: AuthContext): boolean {
  return hasPermission(ctx, "employee.read") && scopeFor(ctx, "employee.read") === "ALL";
}

export function canManageEmployees(ctx: AuthContext): boolean {
  return hasPermission(ctx, "employee.manage");
}
