import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorizeAny, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "@/modules/academic/academic.rules";
import { lockSessionShared } from "@/modules/academic/academic.tx";
import { correctionRule, STUDENT_HOLIDAY_SCOPES, summarizeStudentDays, type StudentStatus } from "@/modules/academic/student-attendance.rules";
import { classifyRange } from "@/modules/hr/leave.rules";
import { lockLeaveCalendar } from "@/modules/hr/leave.tx";
import { afterCommit, type NotificationDraft } from "@/modules/notifications/notifications.service";
import { readStudentCalendarTx } from "@/modules/settings/settings.service";
import { familyRecipientsOf } from "./family-recipients.tx";
import { studentDaySchema, studentMonthSchema, type MarkStudentDayInput, type StudentDayInput, type StudentMonthInput } from "./student-attendance.schemas";

/**
 * Phase 4A-M4 — daily student attendance (PHASE_4_PLAN.md AC6, AC7). The students module owns enrollments.
 *
 * Who:
 * - Marks a day: the section's class teacher (`attendance.student.mark` ASSIGNED, open session), an ALL marker, or an
 *   `academic.manage` holder (school office).
 * - Changes a saved mark (AC7): the class teacher / ALL marker on the same day; later only `academic.manage`, with a reason
 *   (personal tier: stored on the row, never in audit rows).
 * - Reads: `attendance.student.read` ALL, or ASSIGNED = own class-teacher section; markers and managers read what they mark.
 *   Out-of-scope sections look missing (NotFound — no oracle).
 * Rules: school days only (student weekly off + holidays for everyone / students excluded), no future dates, the session
 * covers the date and isn't CLOSED, only students enrolled in the section on that date.
 * Lock order: calendar (advisory, shared with holiday and weekly-off writes) → academic_session (SHARE) → section (SHARE)
 * → student_enrollment (SHARE) → student_attendance.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("Attendance for this day was just saved by someone else. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

interface Access {
  /** May first-mark and change same-day marks (class teacher of this section, or an ALL marker). */
  isClassTeacher: boolean;
  /** academic.manage — first marks and later corrections with a reason. */
  canManage: boolean;
  canRead: boolean;
}

export function studentAttendanceAccess(ctx: AuthContext, section: { classTeacherId: string | null; sessionStatus: string }): Access {
  const mark = hasPermission(ctx, "attendance.student.mark") ? scopeFor(ctx, "attendance.student.mark") : null;
  const read = hasPermission(ctx, "attendance.student.read") ? scopeFor(ctx, "attendance.student.read") : null;
  const ownSection = section.classTeacherId === ctx.userId && section.sessionStatus !== "CLOSED";
  const isClassTeacher = mark === "ALL" || (mark === "ASSIGNED" && ownSection);
  const canManage = hasPermission(ctx, "academic.manage");
  const canRead = read === "ALL" || (read === "ASSIGNED" && ownSection) || isClassTeacher || canManage;
  return { isClassTeacher, canManage, canRead };
}

async function sectionFacts(sectionId: string) {
  const s = await prisma.section.findUnique({
    where: { id: sectionId },
    select: {
      id: true,
      code: true,
      classTeacherId: true,
      academicSessionId: true,
      academicSession: { select: { name: true, status: true, startDate: true, endDate: true } },
    },
  });
  if (!s) throw new NotFoundError("Section not found.");
  return s;
}

/** Enrollments of the section that were in it on `date` (enrolled on or before, not left before). */
function enrolledOnWhere(sectionId: string, date: Date) {
  return {
    sectionId,
    enrolledOn: { lte: date },
    OR: [{ leftOn: null }, { leftOn: { gte: date } }],
    student: { deletedAt: null },
  };
}

async function holidaysOn(from: string, to: string) {
  const rows = await prisma.holiday.findMany({
    where: { date: { gte: day(from), lte: day(to) }, appliesTo: { in: [...STUDENT_HOLIDAY_SCOPES] } },
    select: { date: true, name: true },
    take: 400,
  });
  return new Map(rows.map((r) => [iso(r.date), r.name]));
}

// ───────────────────────────── Day ─────────────────────────────

export async function getStudentDay(ctx: AuthContext, raw: StudentDayInput) {
  authorizeAny(ctx, ["attendance.student.read", "attendance.student.mark", "academic.manage"]);
  const input = studentDaySchema.parse(raw);
  const s = await sectionFacts(input.sectionId);
  const access = studentAttendanceAccess(ctx, { classTeacherId: s.classTeacherId, sessionStatus: s.academicSession.status });
  if (!access.canRead) throw new NotFoundError("Section not found.");
  const d = day(input.date);
  const { weeklyOff, timezone } = await prisma.$transaction((tx) => readStudentCalendarTx(tx));
  const today = todayInTimeZone(timezone ?? undefined);
  const [holidays, roster] = await Promise.all([
    holidaysOn(input.date, input.date),
    prisma.studentEnrollment.findMany({
      where: enrolledOnWhere(s.id, d),
      orderBy: [{ rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        rollNumber: { select: { rollNumber: true } },
        student: { select: { studentCode: true, fullName: true } },
        attendance: { where: { date: d }, select: { status: true, version: true, correctionReason: true } },
      },
    }),
  ]);
  const [kind] = classifyRange(input.date, input.date, weeklyOff, new Set(holidays.keys()));
  const inSession = input.date >= iso(s.academicSession.startDate) && input.date <= iso(s.academicSession.endDate);
  const blocker =
    input.date > today
      ? "This date is in the future."
      : !inSession
        ? `The date is outside ${s.academicSession.name}.`
        : s.academicSession.status === "CLOSED"
          ? `${s.academicSession.name} is closed.`
          : kind.kind === "holiday"
            ? `Holiday: ${holidays.get(input.date) ?? ""}`.trim()
            : kind.kind === "weekly_off"
              ? "No school (weekly off)."
              : null;
  const anySaved = roster.some((r) => r.attendance.length > 0);
  const rule = correctionRule({ date: input.date, today, hasSavedMark: anySaved, isClassTeacher: access.isClassTeacher, canManage: access.canManage });
  const firstMark = correctionRule({ date: input.date, today, hasSavedMark: false, isClassTeacher: access.isClassTeacher, canManage: access.canManage });
  return {
    section: { id: s.id, code: s.code, sessionName: s.academicSession.name },
    date: input.date,
    today,
    blocker,
    canMarkNew: blocker === null && firstMark.allowed,
    canChangeSaved: blocker === null && rule.allowed,
    reasonRequired: rule.reasonRequired,
    roster: roster.map((r) => ({
      enrollmentId: r.id,
      rollNumber: r.rollNumber?.rollNumber ?? null,
      studentCode: r.student.studentCode,
      fullName: r.student.fullName,
      mark: r.attendance[0] ? { status: r.attendance[0].status, version: r.attendance[0].version, corrected: r.attendance[0].correctionReason !== null } : null,
    })),
  };
}

/**
 * Phase 6C-M2 (P23): "marked absent today" for the families of students newly marked ABSENT on the school's TODAY —
 * never for back-dated corrections. Once per child per day (dedupe `absence:<student>:<date>`): re-marking or a
 * second save sends nothing new. A later correction to present doesn't recall it (the attendance tab shows the truth).
 */
async function absenceNotifications(enrollmentIds: readonly string[], date: string): Promise<NotificationDraft[]> {
  if (enrollmentIds.length === 0) return [];
  // Still absent after the commit (a concurrent correction may have changed the mark).
  const rows = await prisma.studentAttendance.findMany({ where: { enrollmentId: { in: [...enrollmentIds] }, date: day(date), status: "ABSENT" }, select: { enrollment: { select: { studentId: true } } }, take: 500 });
  const recipients = await familyRecipientsOf(prisma, rows.map((r) => r.enrollment.studentId), { students: false });
  return recipients.map((r) => ({
    userId: r.userId,
    type: "attendance.absent" as const,
    title: "Marked absent today",
    body: `${r.firstName} was marked absent today.`,
    link: `/portal/c/${encodeURIComponent(r.studentId)}/attendance`,
    dedupeKey: `absence:${r.studentId}:${date}`,
  }));
}

export async function markStudentDay(ctx: AuthContext, input: MarkStudentDayInput) {
  authorizeAny(ctx, ["attendance.student.mark", "academic.manage"]);
  let saved: { created: number; changed: number; absentToday: string[] };
  try {
    saved = await prisma.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      await lockLeaveCalendar(tx); // shared calendar lock: holidays and weekly offs can't change under this save
      const peek = await tx.section.findUnique({ where: { id: input.sectionId }, select: { academicSessionId: true } });
      if (!peek) throw new NotFoundError("Section not found.");
      const status = await lockSessionShared(tx, peek.academicSessionId);
      const [sec] = await tx.$queryRaw<{ class_teacher_id: string | null }[]>`SELECT class_teacher_id FROM section WHERE id = ${input.sectionId} FOR SHARE`;
      if (!sec) throw new NotFoundError("Section not found.");
      const access = studentAttendanceAccess(ctx, { classTeacherId: sec.class_teacher_id, sessionStatus: status });
      if (!access.isClassTeacher && !access.canManage) throw new NotFoundError("Section not found.");
      assertSessionWritable(status);
      const session = await tx.academicSession.findUniqueOrThrow({ where: { id: peek.academicSessionId }, select: { name: true, startDate: true, endDate: true } });
      if (input.date < iso(session.startDate) || input.date > iso(session.endDate)) {
        throw new ValidationError(`The date is outside ${session.name}.`, [{ path: "date", message: "Outside the session." }]);
      }
      const { weeklyOff, timezone } = await readStudentCalendarTx(tx);
      const today = todayInTimeZone(timezone ?? undefined);
      if (input.date > today) throw new ValidationError("Attendance can't be marked for a future date.", [{ path: "date", message: "In the future." }]);
      const holidayRows = await tx.holiday.findMany({ where: { date: day(input.date), appliesTo: { in: [...STUDENT_HOLIDAY_SCOPES] } }, select: { date: true } });
      const [kind] = classifyRange(input.date, input.date, weeklyOff, new Set(holidayRows.map((h) => iso(h.date))));
      if (kind.kind !== "working") throw new ConflictError(kind.kind === "holiday" ? "This date is a holiday." : "This date is a weekly off — there is no school.");

      const ids = input.entries.map((e) => e.enrollmentId).sort();
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM student_enrollment WHERE id = ANY(${ids}) AND section_id = ${input.sectionId} ORDER BY id FOR SHARE`;
      if (locked.length !== ids.length) throw new ConflictError("A student on this screen is not in this section. Reload the page and try again.");
      const enrolled = await tx.studentEnrollment.count({ where: { id: { in: ids }, ...enrolledOnWhere(input.sectionId, day(input.date)) } });
      if (enrolled !== ids.length) throw new ConflictError("A student on this screen wasn't in this section on this date. Reload the page and try again.");

      const existing = new Map(
        (await tx.studentAttendance.findMany({ where: { date: day(input.date), enrollmentId: { in: ids } }, select: { id: true, enrollmentId: true, status: true, version: true } })).map((r) => [r.enrollmentId, r]),
      );
      const creates: { enrollmentId: string; status: StudentStatus }[] = [];
      const updates: { id: string; version: number; status: StudentStatus; before: string }[] = [];
      let reasonUsed = false;
      for (const e of input.entries) {
        const cur = existing.get(e.enrollmentId);
        if (!cur) {
          if (e.version !== null) throw new ConflictError("Attendance for this day was changed by someone else. Reload the page and try again.");
          const rule = correctionRule({ date: input.date, today, hasSavedMark: false, isClassTeacher: access.isClassTeacher, canManage: access.canManage });
          if (!rule.allowed) throw new ForbiddenError("You can't mark attendance for this section.");
          creates.push({ enrollmentId: e.enrollmentId, status: e.status });
          continue;
        }
        if (e.version !== cur.version) throw new ConflictError("Attendance for this day was changed by someone else. Reload the page and try again.");
        if (cur.status === e.status) continue;
        const rule = correctionRule({ date: input.date, today, hasSavedMark: true, isClassTeacher: access.isClassTeacher, canManage: access.canManage });
        if (!rule.allowed) throw new ForbiddenError("Saved marks can only be changed on the same day. Ask the school office to correct them.");
        if (rule.reasonRequired) {
          if (input.reason === "") throw new ValidationError("Give a reason for changing saved marks.", [{ path: "reason", message: "Required for corrections of earlier days." }]);
          reasonUsed = true;
        }
        updates.push({ id: cur.id, version: cur.version, status: e.status, before: cur.status });
      }
      if (creates.length > 0) {
        await tx.studentAttendance.createMany({
          data: creates.map((c) => ({ academicSessionId: peek.academicSessionId, enrollmentId: c.enrollmentId, date: day(input.date), status: c.status, markedById: ctx.userId })),
        });
      }
      for (const u of updates) {
        const r = await tx.studentAttendance.updateMany({
          where: { id: u.id, version: u.version },
          data: { status: u.status, markedById: ctx.userId, version: { increment: 1 }, ...(reasonUsed ? { correctionReason: input.reason } : {}) },
        });
        if (r.count !== 1) throw new ConflictError("Attendance for this day was changed by someone else. Reload the page and try again.");
      }
      if (creates.length + updates.length > 0) {
        const byStatus: Record<string, number> = {};
        for (const st of [...creates.map((c) => c.status), ...updates.map((u) => u.status)]) byStatus[st] = (byStatus[st] ?? 0) + 1;
        // Counts and ids only — never names or the correction reason.
        await audit(tx, actorOf(ctx), {
          action: updates.length > 0 ? "student_attendance.correct" : "student_attendance.mark",
          entityType: "Section",
          entityId: input.sectionId,
          after: { date: input.date, created: creates.length, changed: updates.length, byStatus, corrections: updates.map((u) => ({ id: u.id, before: u.before, after: u.status })) },
        });
      }
      const absentToday = input.date === today ? [...creates.filter((c) => c.status === "ABSENT").map((c) => c.enrollmentId), ...updates.filter((u) => u.status === "ABSENT").map((u) => existingEnrollmentOf(existing, u.id))] : [];
      return { created: creates.length, changed: updates.length, absentToday: absentToday.filter((x): x is string => x !== null) };
    });
  } catch (e) {
    return busy(e);
  }
  await afterCommit("absence", () => absenceNotifications(saved.absentToday, input.date));
  return { created: saved.created, changed: saved.changed };
}

function existingEnrollmentOf(existing: Map<string, { id: string; enrollmentId: string }>, attendanceId: string): string | null {
  for (const r of existing.values()) if (r.id === attendanceId) return r.enrollmentId;
  return null;
}

// ───────────────────────────── Month register ─────────────────────────────

export async function getStudentMonth(ctx: AuthContext, raw: StudentMonthInput) {
  authorizeAny(ctx, ["attendance.student.read", "attendance.student.mark", "academic.manage"]);
  const input = studentMonthSchema.parse(raw);
  const s = await sectionFacts(input.sectionId);
  if (!studentAttendanceAccess(ctx, { classTeacherId: s.classTeacherId, sessionStatus: s.academicSession.status }).canRead) throw new NotFoundError("Section not found.");
  const [y, mo] = input.month.split("-").map(Number);
  const from = `${input.month}-01`;
  const to = `${input.month}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`;
  const { weeklyOff, timezone } = await prisma.$transaction((tx) => readStudentCalendarTx(tx));
  const today = todayInTimeZone(timezone ?? undefined);
  const [holidays, enrollments] = await Promise.all([
    holidaysOn(from, to),
    prisma.studentEnrollment.findMany({
      where: { sectionId: s.id, enrolledOn: { lte: day(to) }, OR: [{ leftOn: null }, { leftOn: { gte: day(from) } }], student: { deletedAt: null } },
      orderBy: [{ rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
      take: 200,
      select: {
        id: true,
        enrolledOn: true,
        leftOn: true,
        rollNumber: { select: { rollNumber: true } },
        student: { select: { studentCode: true, fullName: true } },
        attendance: { where: { date: { gte: day(from), lte: day(to) } }, select: { date: true, status: true }, take: 31 },
      },
    }),
  ]);
  // The session bounds the school days too.
  const sFrom = iso(s.academicSession.startDate);
  const sTo = iso(s.academicSession.endDate);
  const days = classifyRange(from, to, weeklyOff, new Set(holidays.keys())).map((d) => (d.date < sFrom || d.date > sTo ? { ...d, kind: "holiday" as const } : d));
  return {
    section: { id: s.id, code: s.code, sessionName: s.academicSession.name },
    month: input.month,
    schoolDays: days.filter((d) => d.kind === "working" && d.date <= today).length,
    items: enrollments.map((e) => {
      const marks = new Map(e.attendance.map((a) => [iso(a.date), a.status as StudentStatus]));
      const enrolledFrom = iso(e.enrolledOn);
      const leftOn = e.leftOn ? iso(e.leftOn) : null;
      return {
        enrollmentId: e.id,
        rollNumber: e.rollNumber?.rollNumber ?? null,
        studentCode: e.student.studentCode,
        fullName: e.student.fullName,
        summary: summarizeStudentDays(days, marks, (d) => d >= enrolledFrom && (leftOn === null || d <= leftOn), today),
      };
    }),
  };
}
