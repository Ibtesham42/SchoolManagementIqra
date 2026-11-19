import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import { checkPeriodPlan } from "./timetable.rules";
import type { CopyDayPlanInput, PeriodRow, SaveDayPlanInput, SetSlotInput } from "./timetable.schemas";

/**
 * Phase 4A-M3 — period plan and timetable (PHASE_4_PLAN.md AC5).
 *
 * - Reads: `timetable.read` at ALL (Teacher holds it at ALL; Parent / Student scopes wait for the portal — refused).
 *   "My timetable" reads the caller's own slots (their linked staff record).
 * - Writes: `timetable.manage`; never in a CLOSED session. Every timetable write takes ONE transaction-scoped advisory
 *   lock first (one school, few writers), then the session FOR SHARE.
 * - A period used by the timetable can't be removed or turned into a break. A slot's teacher is the subject's
 *   allocated teacher in that section (allocation row locked FOR SHARE, so a concurrent teacher change waits); the
 *   database refuses a teacher in two sections in one period and two subjects in one section period.
 * Lock order (setSlot): timetable (advisory) → academic_session (SHARE) → section (SHARE) → period (SHARE) →
 * timetable_slot (UPDATE) → class_subject (SHARE) → teacher_allocation (SHARE). Allocation writes take employee →
 * session → section → class_subject → teacher_allocation (UPDATE) and never lock slots; every slot writer holds the
 * advisory lock — so the orders can't deadlock.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const toDb = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
const fromDb = (d: Date) => d.toISOString().slice(11, 16);
export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("Someone else just changed this timetable. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

async function lockTimetable(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.timetable'))) AS l`;
}

function assertReadAll(ctx: AuthContext) {
  if (authorize(ctx, "timetable.read") !== "ALL") throw new ForbiddenError();
}

const PERIOD_SELECT = { id: true, dayOfWeek: true, number: true, label: true, kind: true, startTime: true, endTime: true, version: true } as const;
const shapePeriod = (p: { id: string; dayOfWeek: number; number: number; label: string | null; kind: "TEACHING" | "BREAK"; startTime: Date; endTime: Date; version: number }) => ({
  ...p,
  startTime: fromDb(p.startTime),
  endTime: fromDb(p.endTime),
});

/** "id:version,…" of a day's saved periods, in order — the stale-screen check of `saveDayPlan`. */
export function dayFingerprint(periods: readonly { id: string; version: number }[]): string {
  return periods.map((p) => `${p.id}:${p.version}`).join(",");
}

// ───────────────────────────── Period plan ─────────────────────────────

export async function getPeriodPlan(ctx: AuthContext, academicSessionId: string) {
  assertReadAll(ctx);
  const [session, periods] = await Promise.all([
    prisma.academicSession.findUnique({ where: { id: academicSessionId }, select: { id: true, name: true, status: true } }),
    prisma.period.findMany({
      where: { academicSessionId },
      orderBy: [{ dayOfWeek: "asc" }, { number: "asc" }],
      take: 7 * 15,
      select: { ...PERIOD_SELECT, _count: { select: { slots: true } } },
    }),
  ]);
  if (!session) throw new NotFoundError("Academic session not found.");
  const days = WEEKDAYS.map((name, d) => {
    const list = periods.filter((p) => p.dayOfWeek === d);
    return { dayOfWeek: d, name, fingerprint: dayFingerprint(list), periods: list.map((p) => ({ ...shapePeriod(p), lessons: p._count.slots })) };
  });
  return { session, days };
}

function validateRows(rows: readonly PeriodRow[], dayOfWeek: number) {
  const problems = checkPeriodPlan(rows.map((r, i) => ({ dayOfWeek, number: i + 1, startTime: r.startTime, endTime: r.endTime, kind: r.kind, label: r.label })));
  const p = problems[0];
  if (!p) return;
  const msg =
    p.kind === "overlap"
      ? `Period ${p.index + 1} overlaps period ${p.other + 1}.`
      : p.kind === "ends_before_start"
        ? `Period ${p.index + 1} must end after it starts.`
        : "Check the period times.";
  throw new ValidationError(msg, [{ path: "periods", message: msg }]);
}

/** Save one weekday's plan: positions are period numbers; periods with lessons can't be removed or become breaks. */
export async function saveDayPlan(ctx: AuthContext, input: SaveDayPlanInput) {
  authorize(ctx, "timetable.manage");
  validateRows(input.periods, input.dayOfWeek);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimetable(tx);
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      const existing = await tx.period.findMany({
        where: { academicSessionId: input.academicSessionId, dayOfWeek: input.dayOfWeek },
        orderBy: { number: "asc" },
        select: { id: true, number: true, kind: true, startTime: true, endTime: true, label: true, version: true, _count: { select: { slots: true } } },
      });
      if (dayFingerprint(existing) !== input.fingerprint) throw new ConflictError("This day's periods were changed by someone else. Reload the page and try again.");
      let created = 0;
      let updated = 0;
      let removed = 0;
      for (const [i, row] of input.periods.entries()) {
        const cur = existing[i];
        if (!cur) {
          await tx.period.create({
            data: { academicSessionId: input.academicSessionId, dayOfWeek: input.dayOfWeek, number: i + 1, kind: row.kind, label: row.label, startTime: toDb(row.startTime), endTime: toDb(row.endTime) },
          });
          created += 1;
          continue;
        }
        const same = cur.kind === row.kind && cur.label === row.label && fromDb(cur.startTime) === row.startTime && fromDb(cur.endTime) === row.endTime;
        if (same) continue;
        if (row.kind === "BREAK" && cur._count.slots > 0) throw new ConflictError(`Period ${i + 1} has lessons in the timetable, so it can't become a break.`);
        await tx.period.update({
          where: { id: cur.id },
          data: { kind: row.kind, label: row.label, startTime: toDb(row.startTime), endTime: toDb(row.endTime), version: { increment: 1 } },
        });
        updated += 1;
      }
      for (const cur of existing.slice(input.periods.length)) {
        if (cur._count.slots > 0) throw new ConflictError(`Period ${cur.number} has lessons in the timetable. Clear them before removing it.`);
        await tx.period.delete({ where: { id: cur.id } });
        removed += 1;
      }
      if (created + updated + removed > 0) {
        await audit(tx, actorOf(ctx), {
          action: "period_plan.save",
          entityType: "AcademicSession",
          entityId: input.academicSessionId,
          after: { dayOfWeek: input.dayOfWeek, periods: input.periods.length, created, updated, removed },
        });
      }
      return { created, updated, removed };
    });
  } catch (e) {
    return busy(e);
  }
}

/** Copy one day's plan onto other days (e.g. Monday → Tuesday–Saturday). Target days must have no lessons yet. */
export async function copyDayPlan(ctx: AuthContext, input: CopyDayPlanInput) {
  authorize(ctx, "timetable.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimetable(tx);
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      const source = await tx.period.findMany({
        where: { academicSessionId: input.academicSessionId, dayOfWeek: input.fromDay },
        orderBy: { number: "asc" },
        select: { number: true, kind: true, label: true, startTime: true, endTime: true },
      });
      if (source.length === 0) throw new ValidationError("The day to copy has no periods.", [{ path: "fromDay", message: "No periods on this day." }]);
      for (const d of input.toDays) {
        const current = await tx.period.findMany({ where: { academicSessionId: input.academicSessionId, dayOfWeek: d }, orderBy: { number: "asc" }, select: { id: true, version: true } });
        if (dayFingerprint(current) !== (input.fingerprints[String(d)] ?? "")) {
          throw new ConflictError(`${WEEKDAYS[d]}'s periods were changed by someone else. Reload the page and try again.`);
        }
      }
      const busyDay = await tx.timetableSlot.findFirst({
        where: { academicSessionId: input.academicSessionId, period: { dayOfWeek: { in: input.toDays } } },
        select: { period: { select: { dayOfWeek: true } } },
      });
      if (busyDay) throw new ConflictError(`${WEEKDAYS[busyDay.period.dayOfWeek]} already has lessons. Clear its timetable before replacing its periods.`);
      await tx.period.deleteMany({ where: { academicSessionId: input.academicSessionId, dayOfWeek: { in: input.toDays } } });
      await tx.period.createMany({
        data: input.toDays.flatMap((d) => source.map((p) => ({ academicSessionId: input.academicSessionId, dayOfWeek: d, ...p }))),
      });
      await audit(tx, actorOf(ctx), {
        action: "period_plan.copy",
        entityType: "AcademicSession",
        entityId: input.academicSessionId,
        after: { fromDay: input.fromDay, toDays: input.toDays, periods: source.length },
      });
      return { days: input.toDays.length, periods: source.length };
    });
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Section timetable ─────────────────────────────

export async function getSectionTimetable(ctx: AuthContext, sectionId: string) {
  assertReadAll(ctx);
  const section = await prisma.section.findUnique({
    where: { id: sectionId },
    select: { id: true, code: true, classId: true, academicSessionId: true, academicSession: { select: { name: true, status: true } } },
  });
  if (!section) throw new NotFoundError("Section not found.");
  const [periods, slots, subjects] = await Promise.all([
    prisma.period.findMany({ where: { academicSessionId: section.academicSessionId }, orderBy: [{ dayOfWeek: "asc" }, { number: "asc" }], take: 7 * 15, select: PERIOD_SELECT }),
    prisma.timetableSlot.findMany({
      where: { sectionId },
      take: 7 * 15,
      select: { id: true, periodId: true, classSubjectId: true, version: true, employee: { select: { fullName: true, employeeCode: true } } },
    }),
    prisma.classSubject.findMany({
      where: { academicSessionId: section.academicSessionId, classId: section.classId },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        subject: { select: { code: true, name: true } },
        allocations: { where: { sectionId }, select: { employee: { select: { fullName: true } } } },
      },
    }),
  ]);
  return {
    section,
    periods: periods.map(shapePeriod),
    slots,
    subjects: subjects.map((s) => ({ id: s.id, code: s.subject.code, name: s.subject.name, teacher: s.allocations[0]?.employee.fullName ?? null })),
  };
}

export async function setSlot(ctx: AuthContext, input: SetSlotInput) {
  authorize(ctx, "timetable.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimetable(tx);
      const peek = await tx.section.findUnique({ where: { id: input.sectionId }, select: { academicSessionId: true } });
      if (!peek) throw new NotFoundError("Section not found.");
      assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
      const [sec] = await tx.$queryRaw<{ class_id: string; is_active: boolean; code: string }[]>`
        SELECT class_id, is_active, code FROM section WHERE id = ${input.sectionId} FOR SHARE`;
      if (!sec) throw new NotFoundError("Section not found.");
      const [period] = await tx.$queryRaw<{ academic_session_id: string; kind: string; day_of_week: number; number: number }[]>`
        SELECT academic_session_id, kind::text AS kind, day_of_week, number FROM period WHERE id = ${input.periodId} FOR SHARE`;
      if (!period || period.academic_session_id !== peek.academicSessionId) throw new NotFoundError("Period not found. Reload the page and try again.");
      const [slot] = await tx.$queryRaw<{ id: string; version: number; class_subject_id: string }[]>`
        SELECT id, version, class_subject_id FROM timetable_slot WHERE section_id = ${input.sectionId} AND period_id = ${input.periodId} FOR UPDATE`;
      if ((slot?.version ?? null) !== input.version) throw new ConflictError("This period was changed by someone else. Reload the page and try again.");
      const where = `${WEEKDAYS[period.day_of_week]} period ${period.number}`;

      if (input.classSubjectId === null) {
        if (!slot) return { changed: false };
        await tx.timetableSlot.delete({ where: { id: slot.id } });
        await audit(tx, actorOf(ctx), { action: "timetable_slot.clear", entityType: "TimetableSlot", entityId: slot.id, before: { sectionId: input.sectionId, periodId: input.periodId, classSubjectId: slot.class_subject_id } });
        return { changed: true };
      }
      if (!sec.is_active) throw new ConflictError("This section is inactive.");
      if (period.kind !== "TEACHING") throw new ConflictError(`${where} is a break.`);
      const [cs] = await tx.$queryRaw<{ class_id: string; academic_session_id: string }[]>`
        SELECT class_id, academic_session_id FROM class_subject WHERE id = ${input.classSubjectId} FOR SHARE`;
      if (!cs || cs.class_id !== sec.class_id || cs.academic_session_id !== peek.academicSessionId) {
        throw new ValidationError("This subject isn't taught in this section's class this session.", [{ path: "classSubjectId", message: "Not a subject of this class." }]);
      }
      const [alloc] = await tx.$queryRaw<{ employee_id: string }[]>`
        SELECT employee_id FROM teacher_allocation WHERE section_id = ${input.sectionId} AND class_subject_id = ${input.classSubjectId} FOR SHARE`;
      const employeeId = alloc?.employee_id ?? null;
      if (employeeId) {
        const clash = await tx.timetableSlot.findFirst({
          where: { periodId: input.periodId, employeeId, sectionId: { not: input.sectionId } },
          select: { section: { select: { code: true } }, employee: { select: { fullName: true } } },
        });
        if (clash) throw new ConflictError(`${clash.employee?.fullName ?? "This teacher"} already teaches ${clash.section.code} in ${where}.`);
      }
      if (slot) {
        if (slot.class_subject_id === input.classSubjectId) return { changed: false };
        await tx.timetableSlot.update({ where: { id: slot.id }, data: { classSubjectId: input.classSubjectId, employeeId, version: { increment: 1 } } });
        await audit(tx, actorOf(ctx), {
          action: "timetable_slot.set",
          entityType: "TimetableSlot",
          entityId: slot.id,
          before: { classSubjectId: slot.class_subject_id },
          after: { classSubjectId: input.classSubjectId, employeeId },
        });
      } else {
        const created = await tx.timetableSlot.create({
          data: { academicSessionId: peek.academicSessionId, sectionId: input.sectionId, periodId: input.periodId, classSubjectId: input.classSubjectId, employeeId },
          select: { id: true },
        });
        await audit(tx, actorOf(ctx), {
          action: "timetable_slot.set",
          entityType: "TimetableSlot",
          entityId: created.id,
          after: { sectionId: input.sectionId, periodId: input.periodId, classSubjectId: input.classSubjectId, employeeId },
        });
      }
      return { changed: true, teacherAssigned: employeeId !== null };
    });
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── My timetable ─────────────────────────────

/** The caller's own lessons in a session (their linked staff record). `linked: false` without a link. */
export async function getMyTimetable(ctx: AuthContext, academicSessionId: string) {
  authorize(ctx, "timetable.read");
  if (typeof ctx.employeeId !== "string" || ctx.employeeId === "") return { linked: false as const };
  const [periods, slots] = await Promise.all([
    prisma.period.findMany({ where: { academicSessionId }, orderBy: [{ dayOfWeek: "asc" }, { number: "asc" }], take: 7 * 15, select: PERIOD_SELECT }),
    prisma.timetableSlot.findMany({
      where: { academicSessionId, employeeId: ctx.employeeId },
      take: 7 * 15,
      select: { periodId: true, section: { select: { code: true } }, classSubject: { select: { subject: { select: { name: true, code: true } } } } },
    }),
  ]);
  return { linked: true as const, periods: periods.map(shapePeriod), slots };
}
