import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import { STUDENT_HOLIDAY_SCOPES } from "./student-attendance.rules";
import type { CalendarMonthInput, CreateEventInput, EventRefInput, UpdateEventInput } from "./calendar.schemas";

/**
 * Phase 4C-M3 — academic calendar (PHASE_4_PLAN.md AC18): student holidays (ALL / STUDENTS), exam periods and subject
 * exam dates (exams past DRAFT), and the school's own academic events. Kept separate from public CMS events.
 * - Read: `academic.read` or `timetable.read` at a staff scope (ALL / ASSIGNED). Parents / students: with the portal (AC20).
 * - Events: `academic.manage`; dates inside the session; never in a CLOSED session. Events are school dates, not people
 *   or financial records, so removal is a hard delete (audited).
 * Lock order: academic_session FOR SHARE → academic_event FOR UPDATE.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

/** Staff scopes only (ALL / ASSIGNED): parents and students get the calendar with the portal (AC20), not here. */
const staffScope = (ctx: AuthContext, key: "academic.read" | "timetable.read") => {
  const scope = hasPermission(ctx, key) ? scopeFor(ctx, key) : null;
  return scope === "ALL" || scope === "ASSIGNED";
};
export function calendarAccess(ctx: AuthContext) {
  return { read: staffScope(ctx, "academic.read") || staffScope(ctx, "timetable.read"), manage: hasPermission(ctx, "academic.manage") };
}

export type CalendarEntry =
  | { kind: "holiday"; date: string; endDate: string; title: string }
  | { kind: "exam"; date: string; endDate: string; title: string; examId: string }
  | { kind: "exam_subject"; date: string; endDate: string; title: string; examId: string }
  | { kind: "event"; date: string; endDate: string; title: string; details: string | null; id: string; version: number };

/** One month of the calendar for a session (entries overlapping the month), sorted by date. */
export async function getCalendarMonth(ctx: AuthContext, input: CalendarMonthInput) {
  if (!calendarAccess(ctx).read) throw new ForbiddenError();
  const session = await prisma.academicSession.findUnique({ where: { id: input.academicSessionId }, select: { id: true, name: true, status: true, startDate: true, endDate: true } });
  if (!session) throw new NotFoundError("Academic session not found.");
  const [y, m] = input.month.split("-").map(Number);
  const from = day(`${input.month}-01`);
  const to = new Date(Date.UTC(y, m, 0)); // last day of the month
  const [holidays, exams, examSubjects, events] = await Promise.all([
    prisma.holiday.findMany({ where: { date: { gte: from, lte: to }, appliesTo: { in: [...STUDENT_HOLIDAY_SCOPES] } }, orderBy: { date: "asc" }, take: 62, select: { date: true, name: true } }),
    prisma.examination.findMany({
      where: { academicSessionId: session.id, status: { not: "DRAFT" }, startDate: { not: null, lte: to }, OR: [{ endDate: { gte: from } }, { endDate: null, startDate: { gte: from } }] },
      take: 50,
      select: { id: true, name: true, startDate: true, endDate: true },
    }),
    prisma.examSubject.findMany({
      where: { academicSessionId: session.id, examDate: { gte: from, lte: to }, examination: { status: { not: "DRAFT" } } },
      take: 300,
      select: { examDate: true, examination: { select: { id: true, name: true } }, classSubject: { select: { class: { select: { name: true } }, subject: { select: { name: true } } } } },
    }),
    prisma.academicEvent.findMany({
      where: { academicSessionId: session.id, startDate: { lte: to }, endDate: { gte: from } },
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
  return { session: { id: session.id, name: session.name, status: session.status, startDate: iso(session.startDate), endDate: iso(session.endDate) }, month: input.month, entries };
}

async function lockSessionFor(tx: Tx, sessionId: string, start: string, end: string) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  assertSessionWritable(await lockSessionShared(tx, sessionId));
  const s = await tx.academicSession.findUniqueOrThrow({ where: { id: sessionId }, select: { name: true, startDate: true, endDate: true } });
  if (start < iso(s.startDate) || end > iso(s.endDate)) {
    const msg = `Events must fall within ${s.name} (${iso(s.startDate)} to ${iso(s.endDate)}).`;
    throw new ValidationError(msg, [{ path: "startDate", message: msg }]);
  }
}

async function eventSession(tx: Tx, id: string) {
  const peek = await tx.academicEvent.findUnique({ where: { id }, select: { academicSessionId: true } });
  if (!peek) throw new NotFoundError("Event not found.");
  return peek.academicSessionId;
}

async function lockEventRow(tx: Tx, id: string, version: number) {
  const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM academic_event WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError("Event not found.");
  if (row.version !== version) throw new ConflictError("This event was changed by someone else. Reload the page and try again.");
}

export async function createEvent(ctx: AuthContext, input: CreateEventInput) {
  authorize(ctx, "academic.manage");
  const end = input.endDate ?? input.startDate;
  try {
    return await prisma.$transaction(async (tx) => {
      await lockSessionFor(tx, input.academicSessionId, input.startDate, end);
      const e = await tx.academicEvent.create({
        data: { academicSessionId: input.academicSessionId, title: input.title, startDate: day(input.startDate), endDate: day(end), details: input.details },
        select: { id: true },
      });
      await audit(tx, actorOf(ctx), { action: "academic_event.create", entityType: "AcademicEvent", entityId: e.id, after: { academicSessionId: input.academicSessionId, title: input.title, startDate: input.startDate, endDate: end } });
      return e;
    });
  } catch (e) {
    return busy(e);
  }
}

export async function updateEvent(ctx: AuthContext, input: UpdateEventInput) {
  authorize(ctx, "academic.manage");
  const end = input.endDate ?? input.startDate;
  try {
    await prisma.$transaction(async (tx) => {
      await lockSessionFor(tx, await eventSession(tx, input.id), input.startDate, end);
      await lockEventRow(tx, input.id, input.version);
      await tx.academicEvent.update({ where: { id: input.id }, data: { title: input.title, startDate: day(input.startDate), endDate: day(end), details: input.details, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "academic_event.update", entityType: "AcademicEvent", entityId: input.id, after: { title: input.title, startDate: input.startDate, endDate: end } });
    });
  } catch (e) {
    busy(e);
  }
}

export async function deleteEvent(ctx: AuthContext, input: EventRefInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const sessionId = await eventSession(tx, input.id);
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      assertSessionWritable(await lockSessionShared(tx, sessionId));
      await lockEventRow(tx, input.id, input.version);
      const before = await tx.academicEvent.findUniqueOrThrow({ where: { id: input.id }, select: { title: true, startDate: true, endDate: true } });
      await tx.academicEvent.delete({ where: { id: input.id } });
      await audit(tx, actorOf(ctx), { action: "academic_event.delete", entityType: "AcademicEvent", entityId: input.id, before: { title: before.title, startDate: iso(before.startDate), endDate: iso(before.endDate) } });
    });
  } catch (e) {
    busy(e);
  }
}
