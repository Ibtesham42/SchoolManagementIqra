import { prisma } from "@/lib/db";
import { clampMonth, monthBounds, shiftMonth } from "@/lib/month";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent } from "@/lib/rbac/portal-access";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { STUDENT_HOLIDAY_SCOPES, summarizeStudentDays, type StudentStatus } from "@/modules/academic/student-attendance.rules";
import { classifyRange } from "@/modules/hr/leave.rules";
import { readStudentCalendarTx } from "@/modules/settings/settings.service";
import { currentEnrollment } from "./enrollment-reads.tx";
import { portalWindow } from "./students.portal";

/**
 * Phase 6B-M1 (P10) — a child's attendance for families: one month as a calendar (each school day's mark, holidays and
 * weekly offs), the month summary and the session percentage so far, for the CURRENT enrollment only (a promoted
 * child shows the new section; past sessions appear on report cards). Same rules and percentage as the staff
 * register (`summarizeStudentDays`, `classifyRange`). Leavers: no attendance (P17) — `assertPortalStudent` refuses.
 * Never: correction reasons, who marked, other students.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
/** Sessions may run up to 548 days (settings.rules MAX_SESSION_DAYS); this covers them with room to spare. */
const MAX_DAYS = 600;
const addDays = (isoDate: string, n: number) => iso(new Date(day(isoDate).getTime() + n * 86_400_000));

/**
 * Review 6B-M1 M1: `classifyRange` refuses ranges over 366 days, and a session may be longer — classify in chunks.
 */
export function classifyLongRange(from: string, to: string, w: Parameters<typeof classifyRange>[2], holidays: ReadonlySet<string>) {
  const out: ReturnType<typeof classifyRange> = [];
  for (let a = from; a <= to; a = addDays(a, 366)) {
    const b = addDays(a, 365) < to ? addDays(a, 365) : to;
    out.push(...classifyRange(a, b, w, holidays));
    if (out.length > MAX_DAYS) throw new Error("Range too long");
  }
  return out;
}

export type PortalDayKind = "school" | "weekly_off" | "holiday" | "outside" | "future";
export interface PortalAttendanceDay {
  date: string;
  kind: PortalDayKind;
  status: StudentStatus | null;
  holiday: string | null;
}

export async function getPortalAttendanceMonth(ctx: AuthContext, input: { studentId: string; month?: string }, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, input.studentId, "attendance", w);
  const e = await currentEnrollment(prisma, input.studentId);
  if (!e) return null; // not enrolled anywhere yet: the page says so

  const enrolledTo = e.leftOn ?? e.sessionEnd;
  const month = clampMonth(input.month, e.sessionStart, e.sessionEnd, w.today);
  const { from, to } = monthBounds(month);
  const sessionTo = w.today < e.sessionEnd ? w.today : e.sessionEnd;
  const rangeFrom = e.sessionStart < from ? e.sessionStart : from;
  const rangeTo = to > sessionTo ? to : sessionTo;
  const { weeklyOff } = await prisma.$transaction((tx) => readStudentCalendarTx(tx));
  const [holidays, marks] = await Promise.all([
    prisma.holiday.findMany({ where: { date: { gte: day(rangeFrom), lte: day(rangeTo) }, appliesTo: { in: [...STUDENT_HOLIDAY_SCOPES] } }, orderBy: { date: "asc" }, take: MAX_DAYS, select: { date: true, name: true } }),
    prisma.studentAttendance.findMany({
      where: { enrollmentId: e.enrollmentId, academicSessionId: e.academicSessionId, date: { gte: day(e.sessionStart), lte: day(sessionTo < to ? to : sessionTo) } },
      orderBy: { date: "asc" },
      take: MAX_DAYS, // one row per day at most (unique enrollment + date); a session is ≤ 548 days
      select: { date: true, status: true },
    }),
  ]);
  const holidayNames = new Map(holidays.map((h) => [iso(h.date), h.name]));
  const marked = new Map(marks.map((m) => [iso(m.date), m.status as StudentStatus]));
  const inSession = (d: string) => d >= e.sessionStart && d <= e.sessionEnd;
  const enrolled = (d: string) => d >= e.enrolledOn && d <= enrolledTo;
  const classify = (a: string, b: string) => classifyLongRange(a, b, weeklyOff, new Set(holidayNames.keys())).map((d) => (inSession(d.date) ? d : { ...d, kind: "holiday" as const }));

  const monthDays = classify(from, to);
  const days: PortalAttendanceDay[] = monthDays.map((d) => {
    const outside = !inSession(d.date) || !enrolled(d.date);
    const kind: PortalDayKind = outside ? "outside" : d.kind === "weekly_off" ? "weekly_off" : d.kind === "holiday" ? "holiday" : d.date > w.today ? "future" : "school";
    return { date: d.date, kind, status: kind === "school" ? (marked.get(d.date) ?? null) : null, holiday: holidayNames.get(d.date) ?? null };
  });
  const sessionDays = sessionTo >= e.sessionStart ? classify(e.sessionStart, sessionTo) : [];
  return {
    className: e.className,
    sectionCode: e.sectionCode,
    sessionName: e.sessionName,
    today: w.today,
    month,
    prevMonth: month > e.sessionStart.slice(0, 7) ? shiftMonth(month, -1) : null,
    nextMonth: month < e.sessionEnd.slice(0, 7) && shiftMonth(month, 1) <= w.today.slice(0, 7) ? shiftMonth(month, 1) : null,
    days,
    monthSummary: summarizeStudentDays(monthDays, marked, enrolled, w.today),
    sessionSummary: summarizeStudentDays(sessionDays, marked, enrolled, w.today),
  };
}
export type PortalAttendanceMonth = NonNullable<Awaited<ReturnType<typeof getPortalAttendanceMonth>>>;
