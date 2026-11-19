import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { toCsv } from "@/lib/csv";
import { authorize, authorizeAny, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { findSessionForDateTx, readLeaveCalendarTx } from "@/modules/settings/settings.service";
import { assertActorLinked, canReadPersonal, canViewAttendanceSummary, isOwnRecord } from "./hr.policy";
import { classifyRange, readWeeklyOff, STAFF_HOLIDAY_SCOPES } from "./leave.rules";
import { lockedMonthsBetween, lockLeaveCalendar, setLockTimeout, staffHolidaysBetween } from "./leave.tx";
import {
  ATTENDANCE_STATUS_LABEL,
  employedOn,
  monthBounds,
  PAYROLL_SUMMARY_HEADER,
  payrollMonthSummary,
  planDay,
  summarizeMonth,
  timeFromDb,
  timeToDb,
  type ExistingMark,
} from "./staff-attendance.rules";
import type {
  AttendanceDayQuery,
  AttendanceRegisterInput,
  EmployeeMonthInput,
  MarkDayInput,
  PayrollSummaryExportInput,
  PayrollSummaryInput,
} from "./staff-attendance.schemas";

/**
 * Phase 3B M4 — staff attendance (PHASE_3B_PLAN.md L7–L9, L11).
 *
 * - Marking (L7, `attendance.employee.mark`): one working day, many employees, ONE transaction under the leave-calendar
 *   lock (KI-071) — so a holiday, weekly-off change or leave approval can't interleave. Weekly offs, staff holidays and
 *   approved leave are derived / owned elsewhere and never written here. No future days; no closed session.
 * - Corrections (L8): changing a saved row needs a reason and the row's version; months locked for payroll refuse
 *   every change. The reason is personal tier — stored on the row, never in audit rows.
 * - Maker ≠ subject (KI-069 principle): nobody marks or corrects their OWN attendance, Super Admin included; a
 *   non–Super Admin marker must have a linked staff record so that rule can be applied.
 * - Reads: the register needs `attendance.employee.read` at ALL; one employee's month allows SELF on the caller's
 *   own linked record (L9, "My attendance"). Out-of-scope records look missing.
 *
 * Lock order: leave.tx.ts (calendar → employee → … → employee_attendance).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({
  userId: ctx.userId,
  label: ctx.username,
  ipHash: ctx.ipHash,
  requestId: ctx.requestId,
});
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const LEFT = ["RESIGNED", "TERMINATED", "RETIRED"] as const;
const DAY_LIMIT = 500;
const REGISTER_PAGE_SIZE = 25;

const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

/** Prisma filter: employees on the rolls at some point between two ISO dates (inclusive). */
function onRollsBetween(from: string, to: string) {
  return {
    deletedAt: null,
    joiningDate: { lte: day(to) },
    OR: [{ leavingDate: { gte: day(from) } }, { leavingDate: null, employmentStatus: { notIn: [...LEFT] } }],
  };
}

async function readCalendar() {
  const setting = await prisma.schoolSetting.findFirst({ select: { weeklyOff: true, timezone: true } });
  return {
    weeklyOff: readWeeklyOff(setting?.weeklyOff ?? null),
    today: todayInTimeZone(setting?.timezone ?? undefined),
  };
}

async function holidaysBetween(from: string, to: string) {
  const rows = await prisma.holiday.findMany({
    where: { date: { gte: day(from), lte: day(to) }, appliesTo: { in: [...STAFF_HOLIDAY_SCOPES] } },
    select: { date: true, name: true },
    orderBy: { date: "asc" },
    take: 400,
  });
  return new Map(rows.map((r) => [iso(r.date), r.name]));
}

const employeeHeader = {
  id: true,
  employeeCode: true,
  fullName: true,
  joiningDate: true,
  leavingDate: true,
  employmentStatus: true,
  department: { select: { name: true } },
  designation: { select: { name: true } },
} as const;

const rollsOf = (e: { joiningDate: Date; leavingDate: Date | null; employmentStatus: string }) => ({
  joiningDate: iso(e.joiningDate),
  leavingDate: e.leavingDate ? iso(e.leavingDate) : null,
  employmentStatus: e.employmentStatus,
});

// ───────────────────────────── Mark / correct a day (L7, L8) ─────────────────────────────

export async function markAttendanceDay(ctx: AuthContext, input: MarkDayInput) {
  authorize(ctx, "attendance.employee.mark");
  assertActorLinked(ctx);
  if (input.entries.some((e) => isOwnRecord(ctx, e.employeeId))) {
    throw new ForbiddenError("You can't mark your own attendance. Someone else with the marking permission must do it.");
  }
  try {
    return await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockLeaveCalendar(tx);

      const ids = [...input.entries.map((e) => e.employeeId)].sort();
      const emps = await tx.$queryRaw<{ id: string; joining_date: Date; leaving_date: Date | null; employment_status: string }[]>`
        SELECT id, joining_date, leaving_date, employment_status::text AS employment_status
        FROM employee WHERE id = ANY(${ids}) AND deleted_at IS NULL ORDER BY id FOR SHARE`;
      if (emps.length !== ids.length) throw new NotFoundError("Employee not found. Reload the page and try again.");
      const offRolls = emps.find(
        (e) =>
          !employedOn(
            { joiningDate: iso(e.joining_date), leavingDate: e.leaving_date ? iso(e.leaving_date) : null, employmentStatus: e.employment_status },
            input.date,
          ),
      );
      if (offRolls) throw new ConflictError("Someone on this screen wasn't on the staff rolls on this date. Reload the page and try again.");

      const session = await findSessionForDateTx(tx, input.date);
      if (!session) throw new ValidationError("No academic session covers this date.", [{ path: "date", message: "Outside every academic session." }]);
      await tx.$queryRaw`SELECT id FROM academic_session WHERE id = ${session.id} FOR SHARE`;
      const { session: locked, weeklyOff, timezone } = await readLeaveCalendarTx(tx, session.id);
      if (locked.status === "CLOSED") throw new ConflictError(`${session.name} is closed.`);
      // Re-checked under the row lock: a session date edit committed between lookup and lock is seen (audit M4-L2).
      if (input.date < iso(locked.startDate) || input.date > iso(locked.endDate)) {
        throw new ConflictError("The academic session's dates changed. Reload the page and try again.");
      }
      if (input.date > todayInTimeZone(timezone ?? undefined)) {
        throw new ValidationError("Attendance can't be marked for a future date.", [{ path: "date", message: "In the future." }]);
      }
      if ((await lockedMonthsBetween(tx, input.date, input.date)).length > 0) {
        throw new ConflictError(`Attendance for ${input.date.slice(0, 7)} is locked for payroll.`);
      }
      const holidays = await staffHolidaysBetween(tx, input.date, input.date);
      const [kind] = classifyRange(input.date, input.date, weeklyOff, holidays);
      if (kind.kind !== "working") {
        throw new ConflictError(
          kind.kind === "holiday" ? "This date is a staff holiday — there is nothing to mark." : "This date is a weekly off — there is nothing to mark.",
        );
      }

      const rows = await tx.employeeAttendance.findMany({
        where: { date: day(input.date), employeeId: { in: ids } },
        select: { id: true, employeeId: true, status: true, checkIn: true, checkOut: true, leaveRequestId: true, version: true },
      });
      const existing: ExistingMark[] = rows.map((r) => ({ ...r, checkIn: timeFromDb(r.checkIn), checkOut: timeFromDb(r.checkOut) }));
      const plan = planDay(existing, input.entries, input.reason !== "");
      const problem = plan.problems[0];
      if (problem) {
        if (problem.kind === "on_leave") throw new ConflictError("Someone on this screen is on approved leave that day. Leave days can't be changed here.");
        if (problem.kind === "stale") throw new ConflictError("Attendance for this day was changed by someone else. Reload the page and try again.");
        throw new ValidationError("Saved marks are being changed — give a reason for the correction.", [{ path: "reason", message: "Required when changing saved marks." }]);
      }

      if (plan.create.length > 0) {
        await tx.employeeAttendance.createMany({
          data: plan.create.map((e) => ({
            employeeId: e.employeeId,
            date: day(input.date),
            status: e.status,
            checkIn: e.checkIn ? timeToDb(e.checkIn) : null,
            checkOut: e.checkOut ? timeToDb(e.checkOut) : null,
            markedById: ctx.userId,
          })),
        });
      }
      for (const c of plan.correct) {
        const r = await tx.employeeAttendance.updateMany({
          where: { id: c.id, version: c.version, leaveRequestId: null },
          data: {
            status: c.entry.status,
            checkIn: c.entry.checkIn ? timeToDb(c.entry.checkIn) : null,
            checkOut: c.entry.checkOut ? timeToDb(c.entry.checkOut) : null,
            correctionReason: input.reason,
            markedById: ctx.userId,
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw new ConflictError("Attendance for this day was changed by someone else. Reload the page and try again.");
      }

      const byStatus: Record<string, number> = {};
      for (const e of [...plan.create, ...plan.correct.map((c) => c.entry)]) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
      if (plan.create.length + plan.correct.length > 0) {
        // Counts and ids only — the correction reason is personal tier and stays on the rows (R4).
        await audit(tx, actorOf(ctx), {
          action: plan.correct.length > 0 ? "staff_attendance.correct" : "staff_attendance.mark",
          entityType: "EmployeeAttendanceDay",
          entityId: input.date,
          after: {
            date: input.date,
            created: plan.create.length,
            corrected: plan.correct.length,
            unchanged: plan.unchanged,
            byStatus,
            corrections: plan.correct.map((c) => ({ employeeId: c.entry.employeeId, before: c.before, after: c.entry.status })),
          },
        });
      }
      return { created: plan.create.length, corrected: plan.correct.length, unchanged: plan.unchanged };
    });
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Day screen (markers) ─────────────────────────────

export async function getAttendanceDay(ctx: AuthContext, input: AttendanceDayQuery) {
  authorize(ctx, "attendance.employee.mark");
  const { weeklyOff, today } = await readCalendar();
  const d = day(input.date);
  const [holidays, session, lock, departments, employees] = await Promise.all([
    holidaysBetween(input.date, input.date),
    prisma.academicSession.findFirst({ where: { startDate: { lte: d }, endDate: { gte: d } }, select: { name: true, status: true } }),
    prisma.attendancePeriodLock.findUnique({ where: { month: day(`${input.date.slice(0, 7)}-01`) }, select: { id: true } }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } }),
    prisma.employee.findMany({
      where: { ...onRollsBetween(input.date, input.date), ...(input.departmentId ? { departmentId: input.departmentId } : {}) },
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      take: DAY_LIMIT + 1,
      select: employeeHeader,
    }),
  ]);
  const onRolls = employees.slice(0, DAY_LIMIT).filter((e) => employedOn(rollsOf(e), input.date));
  const rows = onRolls.length
    ? await prisma.employeeAttendance.findMany({
        where: { date: d, employeeId: { in: onRolls.map((e) => e.id) } },
        select: {
          employeeId: true,
          status: true,
          checkIn: true,
          checkOut: true,
          version: true,
          leaveRequestId: true,
          leaveRequest: { select: { leaveType: { select: { code: true } } } },
        },
      })
    : [];
  const byEmployee = new Map(rows.map((r) => [r.employeeId, r]));
  const [kind] = classifyRange(input.date, input.date, weeklyOff, new Set(holidays.keys()));
  const blocker =
    input.date > today
      ? "This date is in the future."
      : !session
        ? "No academic session covers this date."
        : session.status === "CLOSED"
          ? `${session.name} is closed.`
          : lock
            ? "This month is locked for payroll."
            : kind.kind === "holiday"
              ? `Staff holiday: ${holidays.get(input.date) ?? ""}`.trim()
              : kind.kind === "weekly_off"
                ? "Weekly off."
                : null;
  return {
    date: input.date,
    today,
    kind: kind.kind,
    blocker,
    canMark: blocker === null,
    departments,
    truncated: employees.length > DAY_LIMIT,
    employees: onRolls.map((e) => {
      const r = byEmployee.get(e.id);
      return {
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        department: e.department.name,
        designation: e.designation.name,
        own: isOwnRecord(ctx, e.id),
        mark: r
          ? {
              status: r.status,
              checkIn: timeFromDb(r.checkIn),
              checkOut: timeFromDb(r.checkOut),
              version: r.version,
              leaveCode: r.leaveRequestId ? (r.leaveRequest?.leaveType.code ?? "") : null,
            }
          : null,
      };
    }),
  };
}

// ───────────────────────────── Monthly register (ALL readers) ─────────────────────────────

export async function getAttendanceRegister(ctx: AuthContext, input: AttendanceRegisterInput) {
  if (authorize(ctx, "attendance.employee.read") !== "ALL") throw new ForbiddenError();
  const { from, to } = monthBounds(input.month);
  const { weeklyOff, today } = await readCalendar();
  const where = { ...onRollsBetween(from, to), ...(input.departmentId ? { departmentId: input.departmentId } : {}) };
  const [holidays, lock, departments, total, employees] = await Promise.all([
    holidaysBetween(from, to),
    prisma.attendancePeriodLock.findUnique({ where: { month: day(from) }, select: { lockedAt: true } }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } }),
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      skip: (input.page - 1) * REGISTER_PAGE_SIZE,
      take: REGISTER_PAGE_SIZE,
      select: employeeHeader,
    }),
  ]);
  const rows = employees.length
    ? await prisma.employeeAttendance.findMany({
        where: { employeeId: { in: employees.map((e) => e.id) }, date: { gte: day(from), lte: day(to) } },
        select: { employeeId: true, date: true, status: true, leaveRequestId: true },
        take: REGISTER_PAGE_SIZE * 31,
      })
    : [];
  const days = classifyRange(from, to, weeklyOff, new Set(holidays.keys()));
  const byEmployee = new Map<string, Map<string, { status: string; leaveRequestId: string | null }>>();
  for (const r of rows) {
    const m = byEmployee.get(r.employeeId) ?? new Map();
    m.set(iso(r.date), { status: r.status, leaveRequestId: r.leaveRequestId });
    byEmployee.set(r.employeeId, m);
  }
  return {
    month: input.month,
    today,
    locked: lock !== null,
    departments,
    total,
    page: input.page,
    pageSize: REGISTER_PAGE_SIZE,
    workingDaysInMonth: days.filter((d) => d.kind === "working").length,
    items: employees.map((e) => {
      const w = rollsOf(e);
      return {
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        department: e.department.name,
        designation: e.designation.name,
        summary: summarizeMonth(days, byEmployee.get(e.id) ?? new Map(), (d) => employedOn(w, d), today),
      };
    }),
  };
}

// ───────────────────────────── One employee's month (ALL, or SELF = own) ─────────────────────────────

export async function getEmployeeAttendanceMonth(ctx: AuthContext, input: EmployeeMonthInput) {
  const scope = authorize(ctx, "attendance.employee.read");
  const own = isOwnRecord(ctx, input.employeeId);
  if (scope !== "ALL" && !(scope === "SELF" && own)) throw new NotFoundError("Employee not found.");
  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, deletedAt: null }, select: employeeHeader });
  if (!emp) throw new NotFoundError("Employee not found.");
  return monthFor(ctx, emp, input.month, own);
}

/** "My attendance" (L9): the caller's own linked record. `linked: false` when the login has no staff record. */
export async function getMyAttendance(ctx: AuthContext, month: string) {
  authorize(ctx, "attendance.employee.read");
  if (typeof ctx.employeeId !== "string" || ctx.employeeId === "") return { linked: false as const };
  const emp = await prisma.employee.findFirst({ where: { id: ctx.employeeId, deletedAt: null }, select: employeeHeader });
  if (!emp) return { linked: false as const };
  return { linked: true as const, ...(await monthFor(ctx, emp, month, true)) };
}

async function monthFor(
  ctx: AuthContext,
  emp: { id: string; employeeCode: string; fullName: string; joiningDate: Date; leavingDate: Date | null; employmentStatus: string; department: { name: string }; designation: { name: string } },
  month: string,
  own: boolean,
) {
  const { from, to } = monthBounds(month);
  const { weeklyOff, today } = await readCalendar();
  const [holidays, lock, rows] = await Promise.all([
    holidaysBetween(from, to),
    prisma.attendancePeriodLock.findUnique({ where: { month: day(from) }, select: { id: true } }),
    prisma.employeeAttendance.findMany({
      where: { employeeId: emp.id, date: { gte: day(from), lte: day(to) } },
      orderBy: { date: "asc" },
      take: 31,
      select: {
        date: true,
        status: true,
        checkIn: true,
        checkOut: true,
        version: true,
        correctionReason: true,
        leaveRequestId: true,
        updatedAt: true,
        leaveRequest: { select: { leaveType: { select: { code: true, name: true } } } },
      },
    }),
  ]);
  // The correction reason is personal tier: the employee, personal-tier readers and markers.
  const seeReasons = own || canReadPersonal(ctx) || hasPermission(ctx, "attendance.employee.mark");
  const w = rollsOf(emp);
  const byDate = new Map(rows.map((r) => [iso(r.date), r]));
  const days = classifyRange(from, to, weeklyOff, new Set(holidays.keys()));
  const canMark =
    hasPermission(ctx, "attendance.employee.mark") && !own && lock === null;
  return {
    employee: {
      id: emp.id,
      employeeCode: emp.employeeCode,
      fullName: emp.fullName,
      department: emp.department.name,
      designation: emp.designation.name,
    },
    month,
    today,
    locked: lock !== null,
    own,
    canMark,
    summary: summarizeMonth(days, byDate, (d) => employedOn(w, d), today),
    days: days.map((d) => {
      const r = byDate.get(d.date);
      return {
        date: d.date,
        kind: d.kind,
        onRolls: employedOn(w, d.date),
        holidayName: holidays.get(d.date) ?? null,
        mark: r
          ? {
              status: r.status,
              label: ATTENDANCE_STATUS_LABEL[r.status] ?? r.status,
              checkIn: timeFromDb(r.checkIn),
              checkOut: timeFromDb(r.checkOut),
              version: r.version,
              corrected: r.correctionReason !== null,
              correctionReason: seeReasons ? r.correctionReason : null,
              leave: r.leaveRequestId ? (r.leaveRequest?.leaveType ?? null) : null,
            }
          : null,
      };
    }),
  };
}

// ───────────────────────────── 3B-M5: payroll summary + CSV ─────────────────────────────

const SUMMARY_EXPORT_MAX = 5000;
const SUMMARY_CHUNK = 200;

type HeaderRow = Awaited<ReturnType<typeof prisma.employee.findMany<{ select: typeof employeeHeader }>>>[number];

/** Payroll summaries for some employees in one month (rows read in chunks; bounded by the caller's page / limit). */
async function summariesFor(employees: HeaderRow[], month: string) {
  const { from, to } = monthBounds(month);
  const { weeklyOff, today } = await readCalendar();
  const holidays = await holidaysBetween(from, to);
  const days = classifyRange(from, to, weeklyOff, new Set(holidays.keys()));
  const byEmployee = new Map<string, Map<string, { status: string; leaveRequestId: string | null; leavePaid: boolean | null }>>();
  for (let i = 0; i < employees.length; i += SUMMARY_CHUNK) {
    const ids = employees.slice(i, i + SUMMARY_CHUNK).map((e) => e.id);
    const rows = await prisma.employeeAttendance.findMany({
      where: { employeeId: { in: ids }, date: { gte: day(from), lte: day(to) } },
      select: { employeeId: true, date: true, status: true, leaveRequestId: true, leaveRequest: { select: { leaveType: { select: { isPaid: true } } } } },
      take: ids.length * 31,
    });
    for (const r of rows) {
      const m = byEmployee.get(r.employeeId) ?? new Map();
      m.set(iso(r.date), { status: r.status, leaveRequestId: r.leaveRequestId, leavePaid: r.leaveRequest?.leaveType.isPaid ?? null });
      byEmployee.set(r.employeeId, m);
    }
  }
  return {
    today,
    items: employees.map((e) => {
      const w = rollsOf(e);
      return {
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        department: e.department.name,
        designation: e.designation.name,
        summary: payrollMonthSummary(days, byEmployee.get(e.id) ?? new Map(), (d) => employedOn(w, d), today),
      };
    }),
  };
}

function assertSummaryAccess(ctx: AuthContext) {
  authorizeAny(ctx, ["attendance.employee.read", "payroll.prepare"]);
  if (!canViewAttendanceSummary(ctx)) throw new ForbiddenError("You don't have permission to see the attendance summary for payroll.");
}

export async function getPayrollAttendanceSummary(ctx: AuthContext, input: PayrollSummaryInput) {
  assertSummaryAccess(ctx);
  const { from, to } = monthBounds(input.month);
  const where = { ...onRollsBetween(from, to), ...(input.departmentId ? { departmentId: input.departmentId } : {}) };
  const [total, employees, departments, lock] = await Promise.all([
    prisma.employee.count({ where }),
    prisma.employee.findMany({
      where,
      orderBy: [{ fullName: "asc" }, { id: "asc" }],
      skip: (input.page - 1) * REGISTER_PAGE_SIZE,
      take: REGISTER_PAGE_SIZE,
      select: employeeHeader,
    }),
    prisma.department.findMany({ where: { isActive: true }, orderBy: { name: "asc" }, take: 200, select: { id: true, name: true } }),
    prisma.attendancePeriodLock.findUnique({ where: { month: day(from) }, select: { id: true } }),
  ]);
  const { today, items } = await summariesFor(employees, input.month);
  return { month: input.month, today, total, page: input.page, pageSize: REGISTER_PAGE_SIZE, departments, locked: lock !== null, items };
}

/** CSV of the whole month (≤ 5,000 staff): counts only, formula-safe cells, audited (filters and row count). */
export async function exportPayrollAttendanceSummary(ctx: AuthContext, input: PayrollSummaryExportInput): Promise<{ csv: string; rows: number }> {
  authorize(ctx, "export.run");
  assertSummaryAccess(ctx);
  const { from, to } = monthBounds(input.month);
  const employees = await prisma.employee.findMany({
    where: { ...onRollsBetween(from, to), ...(input.departmentId ? { departmentId: input.departmentId } : {}) },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: SUMMARY_EXPORT_MAX + 1,
    select: employeeHeader,
  });
  if (employees.length > SUMMARY_EXPORT_MAX) {
    throw new ConflictError(`Too many staff for one export (limit ${SUMMARY_EXPORT_MAX}). Choose a department.`);
  }
  const { items } = await summariesFor(employees, input.month);
  const csv = toCsv(
    PAYROLL_SUMMARY_HEADER,
    items.map(({ employeeCode, fullName, department, designation, summary: s }) => [
      employeeCode, fullName, department, designation, s.monthWorkingDays, s.offRollsDays, s.workingDays, s.weeklyOffs, s.holidays, s.present, s.late, s.halfDays,
      s.paidLeave.toString(), s.unpaidLeave.toString(), s.absent, s.unmarked, s.lopDays.toString(), s.complete ? "Yes" : "No",
    ]),
  );
  await prisma.$transaction((tx) =>
    audit(tx, actorOf(ctx), {
      action: "staff_attendance.summary_export",
      entityType: "EmployeeAttendance",
      entityId: input.month,
      after: { month: input.month, departmentFilter: input.departmentId !== null, rows: items.length, format: "csv" },
    }),
  );
  return { csv, rows: items.length };
}
