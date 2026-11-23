import { prisma } from "@/lib/db";
import { STUDENT_HOLIDAY_SCOPES } from "./student-attendance.rules";

/**
 * Read-only calendar lookups shared by the staff calendar (`calendar.service.getCalendarMonth`) and the portal
 * (`calendar.portal.ts`, Phase 6B-M1), so the two never drift. NO AUTHORIZATION HERE (review 6B-M1 L3): every caller
 * has authorized its own read first — staff scopes, or `assertPortalStudent`. School-wide data only (holidays, exams,
 * events); `classId` limits subject exam dates to one class.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

export type CalendarEntry =
  | { kind: "holiday"; date: string; endDate: string; title: string }
  | { kind: "exam"; date: string; endDate: string; title: string; examId: string }
  | { kind: "exam_subject"; date: string; endDate: string; title: string; examId: string }
  | { kind: "event"; date: string; endDate: string; title: string; details: string | null; id: string; version: number };

/** The calendar entries of one month of a session, sorted by date. */
export async function calendarEntries(academicSessionId: string, month: string, opts: { classId?: string } = {}): Promise<CalendarEntry[]> {
  const [y, m] = month.split("-").map(Number);
  const from = day(`${month}-01`);
  const to = new Date(Date.UTC(y, m, 0)); // last day of the month
  const [holidays, exams, examSubjects, events] = await Promise.all([
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to }, appliesTo: { in: [...STUDENT_HOLIDAY_SCOPES] } }, orderBy: { date: "asc" }, take: 62, select: { date: true, name: true } }),
    prisma.examination.findMany({
      where: { academicSessionId, status: { not: "DRAFT" }, startDate: { not: null, lte: to }, OR: [{ endDate: { gte: from } }, { endDate: null, startDate: { gte: from } }] },
      take: 50,
      select: { id: true, name: true, startDate: true, endDate: true },
    }),
    prisma.examSubject.findMany({
      where: { academicSessionId, examDate: { gte: from, lte: to }, examination: { status: { not: "DRAFT" } }, ...(opts.classId ? { classSubject: { classId: opts.classId } } : {}) },
      take: 300,
      select: { examDate: true, examination: { select: { id: true, name: true } }, classSubject: { select: { class: { select: { name: true } }, subject: { select: { name: true } } } } },
    }),
    prisma.academicEvent.findMany({
      where: { academicSessionId, startDate: { lte: to }, endDate: { gte: from } },
      orderBy: { startDate: "asc" },
      take: 100,
      select: { id: true, version: true, title: true, details: true, startDate: true, endDate: true },
    }),
  ]);
  const entries: CalendarEntry[] = [
    ...holidays.map((h) => ({ kind: "holiday" as const, date: iso(h.date), endDate: iso(h.date), title: h.name })),
    ...exams.map((e) => ({ kind: "exam" as const, date: iso(e.startDate!), endDate: iso(e.endDate ?? e.startDate!), title: e.name, examId: e.id })),
    ...examSubjects.map((s) => ({
      kind: "exam_subject" as const,
      date: iso(s.examDate!),
      endDate: iso(s.examDate!),
      title: `${s.examination.name}: ${s.classSubject.class.name} ${s.classSubject.subject.name}`,
      examId: s.examination.id,
    })),
    ...events.map((e) => ({ kind: "event" as const, date: iso(e.startDate), endDate: iso(e.endDate), title: e.title, details: e.details, id: e.id, version: e.version })),
  ];
  entries.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  return entries;
}

