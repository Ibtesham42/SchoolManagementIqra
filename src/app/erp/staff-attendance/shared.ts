import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { canViewAttendanceSummary } from "@/modules/hr/hr.policy";
import { MONTH_RE } from "@/modules/hr/staff-attendance.rules";

type Search = Record<string, string | string[] | undefined>;

/** `?month=YYYY-MM` if valid and not in the future, else the current month. */
export function monthParam(sp: Search, today: string): string {
  const m = typeof sp.month === "string" ? sp.month : "";
  return MONTH_RE.test(m) && m <= today.slice(0, 7) ? m : today.slice(0, 7);
}

/** Which staff-attendance tabs a user may use (cosmetic; every service authorizes). */
export function attendanceTabsFor(ctx: AuthContext) {
  const read = hasPermission(ctx, "attendance.employee.read") ? scopeFor(ctx, "attendance.employee.read") : null;
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";
  return {
    showMine: read !== null && linked,
    showMark: hasPermission(ctx, "attendance.employee.mark"),
    showRegister: read === "ALL",
    showSummary: canViewAttendanceSummary(ctx),
  };
}
