import { prisma } from "@/lib/db";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent } from "@/lib/rbac/portal-access";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { currentEnrollment } from "@/modules/students/enrollment-reads.tx";
import { portalWindow } from "@/modules/students/students.portal";

/**
 * Phase 6B-M1 (P12) — the child's section timetable for families: the week's periods with subject and the teacher's
 * DISPLAY NAME only (no employee code, contact or other staff data). Current enrollment's section; empty days are
 * omitted. Leavers: none (P17). Bounded: ≤ 7 × 15 periods.
 */
const time = (d: Date) => d.toISOString().slice(11, 16);
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export interface PortalPeriod {
  number: number;
  label: string | null;
  kind: "TEACHING" | "BREAK";
  start: string;
  end: string;
  subject: string | null;
  teacher: string | null;
}

export async function getPortalTimetable(ctx: AuthContext, studentId: string, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "timetable", w);
  const e = await currentEnrollment(prisma, studentId);
  if (!e) return null;
  const [periods, slots] = await Promise.all([
    prisma.period.findMany({
      where: { academicSessionId: e.academicSessionId },
      orderBy: [{ dayOfWeek: "asc" }, { number: "asc" }],
      take: 7 * 15,
      select: { id: true, dayOfWeek: true, number: true, label: true, kind: true, startTime: true, endTime: true },
    }),
    prisma.timetableSlot.findMany({
      where: { sectionId: e.sectionId, academicSessionId: e.academicSessionId },
      take: 7 * 15,
      select: { periodId: true, classSubject: { select: { subject: { select: { name: true } } } }, employee: { select: { fullName: true, employmentStatus: true, deletedAt: true } } },
    }),
  ]);
  const byPeriod = new Map(slots.map((s) => [s.periodId, s]));
  const days = WEEKDAY_NAMES.map((name, dayOfWeek) => ({
    dayOfWeek,
    name,
    periods: periods
      .filter((p) => p.dayOfWeek === dayOfWeek)
      .map((p): PortalPeriod => {
        const slot = byPeriod.get(p.id);
        // Review 6B-M1 L5: only a teacher still with the school is named (on leave counts; left / removed don't).
        const emp = slot?.employee;
        const teacher = emp && !emp.deletedAt && (emp.employmentStatus === "ACTIVE" || emp.employmentStatus === "ON_LEAVE") ? emp.fullName : null;
        return { number: p.number, label: p.label, kind: p.kind, start: time(p.startTime), end: time(p.endTime), subject: slot?.classSubject.subject.name ?? null, teacher };
      }),
  })).filter((d) => d.periods.length > 0);
  return { className: e.className, sectionCode: e.sectionCode, sessionName: e.sessionName, days };
}
export type PortalTimetable = NonNullable<Awaited<ReturnType<typeof getPortalTimetable>>>;
