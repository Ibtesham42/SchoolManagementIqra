import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { calendarAccess } from "@/modules/academic/calendar.service";
import { homeworkAccess } from "@/modules/academic/homework.service";

/** Which Academic tabs the user sees (navigation only — every page and service authorizes on its own). */
export function academicTabFlags(ctx: AuthContext) {
  const academic = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  const all = academic === "ALL";
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";
  return {
    showClasses: all,
    showSubjects: all,
    showTimetable: hasPermission(ctx, "timetable.read"),
    showMine: linked && hasPermission(ctx, "timetable.read"),
    showAttendance: hasPermission(ctx, "attendance.student.mark") || hasPermission(ctx, "attendance.student.read"),
    showMarks: hasPermission(ctx, "marks.enter") || hasPermission(ctx, "marks.approve"),
    showHomework: homeworkAccess(ctx).any,
    showCalendar: calendarAccess(ctx).read,
    showPromotion: hasPermission(ctx, "student.promote") || academic === "ASSIGNED",
  };
}
