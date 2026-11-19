import type { Tx } from "@/lib/db";
import { classifyRange, readWeeklyOff, STAFF_HOLIDAY_SCOPES } from "./leave.rules";
import { employedOn, monthBounds, payrollMonthSummary, type PayrollMonthSummary } from "./staff-attendance.rules";

/**
 * Phase 3C-M3 — the HR side of a payroll run, read INSIDE the caller's transaction (no authorization here: the payroll
 * service authorized `payroll.prepare` and holds the payroll and leave-calendar locks, so attendance, holidays and the
 * weekly off can't change underneath). The payroll module never reads HR tables directly.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const LEFT = ["RESIGNED", "TERMINATED", "RETIRED"] as const;
const MAX_STAFF = 2000;
const CHUNK = 200;

export interface PayrollMonthEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  onRolls: (iso: string) => boolean;
  summary: PayrollMonthSummary;
}

export async function payrollMonthInputsTx(tx: Tx, month: string, today: string) {
  const { from, to } = monthBounds(month);
  const setting = await tx.schoolSetting.findFirst({ select: { weeklyOff: true } });
  const holidays = await tx.holiday.findMany({
    where: { date: { gte: day(from), lte: day(to) }, appliesTo: { in: [...STAFF_HOLIDAY_SCOPES] } },
    select: { date: true },
    take: 400,
  });
  const days = classifyRange(from, to, readWeeklyOff(setting?.weeklyOff ?? null), new Set(holidays.map((h) => iso(h.date))));
  const employees = await tx.employee.findMany({
    where: {
      deletedAt: null,
      joiningDate: { lte: day(to) },
      OR: [{ leavingDate: { gte: day(from) } }, { leavingDate: null, employmentStatus: { notIn: [...LEFT] } }],
    },
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: MAX_STAFF + 1,
    select: { id: true, employeeCode: true, fullName: true, joiningDate: true, leavingDate: true, employmentStatus: true },
  });
  if (employees.length > MAX_STAFF) throw new Error(`More than ${MAX_STAFF} staff on the rolls — payroll needs batching.`);
  const marks = new Map<string, Map<string, { status: string; leaveRequestId: string | null; leavePaid: boolean | null }>>();
  for (let i = 0; i < employees.length; i += CHUNK) {
    const ids = employees.slice(i, i + CHUNK).map((e) => e.id);
    const rows = await tx.employeeAttendance.findMany({
      where: { employeeId: { in: ids }, date: { gte: day(from), lte: day(to) } },
      select: { employeeId: true, date: true, status: true, leaveRequestId: true, leaveRequest: { select: { leaveType: { select: { isPaid: true } } } } },
      take: ids.length * 31,
    });
    for (const r of rows) {
      const m = marks.get(r.employeeId) ?? new Map();
      m.set(iso(r.date), { status: r.status, leaveRequestId: r.leaveRequestId, leavePaid: r.leaveRequest?.leaveType.isPaid ?? null });
      marks.set(r.employeeId, m);
    }
  }
  const list: PayrollMonthEmployee[] = employees.map((e) => {
    const w = { joiningDate: iso(e.joiningDate), leavingDate: e.leavingDate ? iso(e.leavingDate) : null, employmentStatus: e.employmentStatus };
    const onRolls = (d: string) => employedOn(w, d);
    return { id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, onRolls, summary: payrollMonthSummary(days, marks.get(e.id) ?? new Map(), onRolls, today) };
  });
  return { days, employees: list };
}

/** Lock a month's attendance for payroll (P5): called by run approval, holding the leave-calendar lock first. */
export async function lockAttendanceMonthTx(tx: Tx, month: string, userId: string) {
  await tx.attendancePeriodLock.upsert({ where: { month: day(`${month}-01`) }, update: {}, create: { month: day(`${month}-01`), lockedById: userId } });
}

/** Unlock on reopen (P16). */
export async function unlockAttendanceMonthTx(tx: Tx, month: string) {
  await tx.attendancePeriodLock.deleteMany({ where: { month: day(`${month}-01`) } });
}
