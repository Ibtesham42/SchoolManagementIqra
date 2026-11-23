import { prisma } from "@/lib/db";
import { clampMonth, shiftMonth } from "@/lib/month";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent } from "@/lib/rbac/portal-access";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { currentEnrollment } from "@/modules/students/enrollment-reads.tx";
import { portalWindow } from "@/modules/students/students.portal";
import { calendarEntries } from "./calendar-reads.tx";

/**
 * Phase 6B-M1 (P12, AC20) — the academic calendar for families: student holidays, exam periods, the subject exam dates
 * of the child's OWN class, and school events, for one month of the child's current session. Same entries as the
 * staff calendar (`calendarEntries`), with internal ids and versions stripped. Leavers: none (P17).
 */
export interface PortalCalendarEntry {
  kind: "holiday" | "exam" | "exam_subject" | "event";
  date: string;
  endDate: string;
  title: string;
  details: string | null;
}

export async function getPortalCalendarMonth(ctx: AuthContext, input: { studentId: string; month?: string }, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, input.studentId, "calendar", w);
  const e = await currentEnrollment(prisma, input.studentId);
  if (!e) return null;
  const month = clampMonth(input.month, e.sessionStart, e.sessionEnd, w.today);
  const entries: PortalCalendarEntry[] = (await calendarEntries(e.academicSessionId, month, { classId: e.classId })).map((x) => ({
    kind: x.kind,
    date: x.date,
    endDate: x.endDate,
    title: x.title,
    details: x.kind === "event" ? x.details : null,
  }));
  return {
    sessionName: e.sessionName,
    month,
    prevMonth: month > e.sessionStart.slice(0, 7) ? shiftMonth(month, -1) : null,
    nextMonth: month < e.sessionEnd.slice(0, 7) ? shiftMonth(month, 1) : null,
    entries,
  };
}
export type PortalCalendarMonth = NonNullable<Awaited<ReturnType<typeof getPortalCalendarMonth>>>;
