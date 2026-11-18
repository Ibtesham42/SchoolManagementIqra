import { NotFoundError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";

/**
 * Pure access rules for staff records (no I/O — unit tested). ADR-036, PHASE_3_PLAN.md §5.3, H6/H7.
 *
 * Two data tiers (H6): the **directory** (`employee.read`) and **personal** details (`employee.personal.read`).
 * Lists and searches need ALL. Single records also allow SELF ("My profile", H7, M3b): SELF means exactly the
 * record linked to the signed-in account (AuthContext.employeeId); without a link, SELF gives nothing
 * (fail closed). Out-of-scope records look missing (NotFound — no oracle).
 */
export type EmployeeTier = "directory" | "personal";

/** Directory access (list, profile header). Throws Forbidden without `employee.read`; NotFound-like for SELF. */
export function employeeReadAccess(ctx: AuthContext): { tier: EmployeeTier } {
  const scope = authorize(ctx, "employee.read");
  if (scope !== "ALL") throw new NotFoundError("Employee not found.");
  return { tier: canReadPersonal(ctx) ? "personal" : "directory" };
}

/** Access to one record: ALL, or SELF on the caller's own linked record. Returns the tier for that record. */
export function employeeRecordAccess(ctx: AuthContext, employeeId: string): { tier: EmployeeTier; own: boolean } {
  const scope = authorize(ctx, "employee.read");
  const own = isOwnRecord(ctx, employeeId);
  if (scope !== "ALL" && !(scope === "SELF" && own)) throw new NotFoundError("Employee not found.");
  const personalScope = hasPermission(ctx, "employee.personal.read") ? scopeFor(ctx, "employee.personal.read") : null;
  return { tier: personalScope === "ALL" || (personalScope === "SELF" && own) ? "personal" : "directory", own };
}

export function isOwnRecord(ctx: AuthContext, employeeId: string): boolean {
  return typeof ctx.employeeId === "string" && ctx.employeeId !== "" && ctx.employeeId === employeeId;
}

/** "My profile" link on the account page: the account is linked and may read (at least) its own record. */
export function canViewOwnProfile(ctx: AuthContext): boolean {
  return typeof ctx.employeeId === "string" && ctx.employeeId !== "" && hasPermission(ctx, "employee.read");
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
