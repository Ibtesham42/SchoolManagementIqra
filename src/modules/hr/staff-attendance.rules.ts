import Decimal from "decimal.js";

/**
 * Pure Phase 3B M4 staff-attendance rules (no I/O — unit tested). PHASE_3B_PLAN.md L7, L8, L11.
 *
 * - Marking (L7) records one of the MANUAL statuses for a working day. ON_LEAVE / leave-linked HALF_DAY rows come
 *   only from leave approval; holidays and weekly offs are derived from the calendar and never stored by marking.
 * - Changing a saved row is a correction (L8): it needs a reason and the row's current version.
 * - Times of day are school-local "HH:MM", stored in `time(0)` columns (Prisma: a Date on 1970-01-01 UTC).
 */

export const MANUAL_STATUSES = ["PRESENT", "ABSENT", "LATE", "HALF_DAY"] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

export const ATTENDANCE_STATUS_LABEL: Record<string, string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  LATE: "Late",
  HALF_DAY: "Half day",
  ON_LEAVE: "On leave",
  HOLIDAY: "Holiday",
  WEEKLY_OFF: "Weekly off",
};

/** One-letter codes for compact calendars (always shown with a legend / accessible label). */
export const ATTENDANCE_STATUS_SHORT: Record<string, string> = {
  PRESENT: "P",
  ABSENT: "A",
  LATE: "L",
  HALF_DAY: "½",
  ON_LEAVE: "LV",
  HOLIDAY: "H",
  WEEKLY_OFF: "WO",
};

// ───────────────────────────── Times ─────────────────────────────

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "HH:MM" → the Date Prisma uses for a `time(0)` column. */
export function timeToDb(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

/** `time(0)` column value → "HH:MM" (or null). */
export function timeFromDb(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(11, 16) : null;
}

// ───────────────────────────── Months ─────────────────────────────

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "2026-11" → first and last ISO dates of the month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

/** Month before / after ("2026-01" → "2025-12"). */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

// ───────────────────────────── Employment window ─────────────────────────────

const LEFT = new Set(["RESIGNED", "TERMINATED", "RETIRED"]);

/**
 * Was the employee on the rolls on `iso`? Joined on or before it, and — once they have left — the leaving date is on
 * or after it. A leaver without a leaving date is treated as gone (fail closed).
 */
export function employedOn(
  emp: { joiningDate: string; leavingDate: string | null; employmentStatus: string },
  iso: string,
): boolean {
  if (emp.joiningDate > iso) return false;
  if (emp.leavingDate !== null && emp.leavingDate < iso) return false;
  if (LEFT.has(emp.employmentStatus) && emp.leavingDate === null) return false;
  return true;
}

// ───────────────────────────── Planning a day's marks ─────────────────────────────

export interface ExistingMark {
  id: string;
  employeeId: string;
  status: string;
  checkIn: string | null;
  checkOut: string | null;
  leaveRequestId: string | null;
  version: number;
}

export interface MarkEntry {
  employeeId: string;
  status: ManualStatus;
  checkIn: string | null;
  checkOut: string | null;
  /** The version the screen showed; null when the screen showed no saved row. */
  version: number | null;
}

export type PlanProblem =
  | { kind: "on_leave"; employeeId: string }
  | { kind: "stale"; employeeId: string }
  | { kind: "reason_required"; employeeId: string };

export interface DayPlan {
  create: MarkEntry[];
  correct: { id: string; version: number; entry: MarkEntry; before: string }[];
  unchanged: number;
  problems: PlanProblem[];
}

/**
 * Decide, per entry, whether it creates a row, corrects one (reason required — L8), or changes nothing. Rows linked to
 * approved leave are never changed by marking (the leave owns them). A version mismatch (or a row that appeared /
 * vanished since the screen loaded) is stale: the caller refuses the whole batch so nothing is overwritten unseen.
 */
export function planDay(
  existing: readonly ExistingMark[],
  entries: readonly MarkEntry[],
  hasReason: boolean,
): DayPlan {
  const byEmployee = new Map(existing.map((e) => [e.employeeId, e]));
  const plan: DayPlan = { create: [], correct: [], unchanged: 0, problems: [] };
  for (const entry of entries) {
    const row = byEmployee.get(entry.employeeId);
    if (!row) {
      if (entry.version !== null) plan.problems.push({ kind: "stale", employeeId: entry.employeeId });
      else plan.create.push(entry);
      continue;
    }
    if (row.leaveRequestId !== null) {
      plan.problems.push({ kind: "on_leave", employeeId: entry.employeeId });
      continue;
    }
    if (entry.version !== row.version) {
      plan.problems.push({ kind: "stale", employeeId: entry.employeeId });
      continue;
    }
    if (row.status === entry.status && row.checkIn === entry.checkIn && row.checkOut === entry.checkOut) {
      plan.unchanged += 1;
      continue;
    }
    if (!hasReason) {
      plan.problems.push({ kind: "reason_required", employeeId: entry.employeeId });
      continue;
    }
    plan.correct.push({ id: row.id, version: row.version, entry, before: row.status });
  }
  return plan;
}

// ───────────────────────────── Monthly summary ─────────────────────────────

export interface MonthSummary {
  /** Working days in the month on which the employee was on the rolls, up to and including today. */
  workingDays: number;
  present: number;
  late: number;
  halfDay: number;
  onLeave: number;
  /** Half-day leave (leave-linked HALF_DAY rows). */
  halfDayLeave: number;
  absent: number;
  /** Working days up to today with no mark at all. */
  unmarked: number;
}

/**
 * Count a month for one employee. `days` are the month's calendar days classified by the leave rules; `rows` the
 * stored marks by ISO date. Only working days on the rolls up to `today` count (future days are neither marked nor
 * missing). Rows on non-working days (none are created by M4) are ignored.
 */
export function summarizeMonth(
  days: readonly { date: string; kind: "working" | "weekly_off" | "holiday" }[],
  rows: ReadonlyMap<string, { status: string; leaveRequestId: string | null }>,
  onRolls: (iso: string) => boolean,
  today: string,
): MonthSummary {
  const s: MonthSummary = { workingDays: 0, present: 0, late: 0, halfDay: 0, onLeave: 0, halfDayLeave: 0, absent: 0, unmarked: 0 };
  for (const d of days) {
    if (d.kind !== "working" || d.date > today || !onRolls(d.date)) continue;
    s.workingDays += 1;
    const r = rows.get(d.date);
    if (!r) {
      s.unmarked += 1;
      continue;
    }
    switch (r.status) {
      case "PRESENT":
        s.present += 1;
        break;
      case "LATE":
        s.late += 1;
        break;
      case "HALF_DAY":
        if (r.leaveRequestId !== null) s.halfDayLeave += 1;
        else s.halfDay += 1;
        break;
      case "ON_LEAVE":
        s.onLeave += 1;
        break;
      case "ABSENT":
        s.absent += 1;
        break;
      default:
        break;
    }
  }
  return s;
}

// ───────────────────────────── 3B-M5: payroll hand-off summary ─────────────────────────────

export interface PayrollMonthSummary {
  /**
   * Working days of the WHOLE month, employed or not — the proration denominator for 3C (audit M5-M1): a mid-month
   * joiner / leaver is paid on (monthWorkingDays − offRollsDays − LOP) / monthWorkingDays, never on their own count.
   */
  monthWorkingDays: number;
  /** Working days of the month before joining or after leaving. */
  offRollsDays: number;
  /** Working days of the month while on the rolls (weekly offs and staff holidays excluded). */
  workingDays: number;
  weeklyOffs: number;
  holidays: number;
  present: number;
  late: number;
  /** Manual half days (no leave): 0.5 LOP each. */
  halfDays: number;
  paidLeave: Decimal;
  unpaidLeave: Decimal;
  absent: number;
  /** Working days with no mark (past days) or not yet reached (future days). */
  unmarked: number;
  /** Loss of pay: absent + unpaid leave + 0.5 × manual half days (payroll-management skill). */
  lopDays: Decimal;
  /** False while the month hasn't ended or a working day is unmarked — payroll must not use it yet (3C). */
  complete: boolean;
}

/**
 * The 3C hand-off for one employee and month. Statuses: PRESENT / LATE = present; manual HALF_DAY = half present,
 * half LOP; ON_LEAVE = one leave day; leave-linked HALF_DAY = half leave (half present); paid or unpaid by the
 * leave type. Unmarked days are never guessed: they are counted and make the month incomplete.
 */
export function payrollMonthSummary(
  days: readonly { date: string; kind: "working" | "weekly_off" | "holiday" }[],
  rows: ReadonlyMap<string, { status: string; leaveRequestId: string | null; leavePaid: boolean | null }>,
  onRolls: (iso: string) => boolean,
  today: string,
): PayrollMonthSummary {
  const s: PayrollMonthSummary = {
    monthWorkingDays: 0, offRollsDays: 0, workingDays: 0, weeklyOffs: 0, holidays: 0, present: 0, late: 0, halfDays: 0,
    paidLeave: new Decimal(0), unpaidLeave: new Decimal(0), absent: 0, unmarked: 0, lopDays: new Decimal(0), complete: true,
  };
  const half = new Decimal("0.5");
  let unknownLeave = false;
  for (const d of days) {
    if (d.kind === "working") s.monthWorkingDays += 1;
    if (!onRolls(d.date)) {
      if (d.kind === "working") s.offRollsDays += 1;
      continue;
    }
    if (d.kind === "weekly_off") s.weeklyOffs += 1;
    if (d.kind === "holiday") s.holidays += 1;
    if (d.kind !== "working") continue;
    s.workingDays += 1;
    const r = rows.get(d.date);
    if (!r || d.date > today) {
      s.unmarked += 1;
      continue;
    }
    const leave = (amount: Decimal) => {
      // Unknown leave type: counted as unpaid (fails safe) and the month is flagged for review (audit M5 low).
      if (r.leavePaid === null) unknownLeave = true;
      if (r.leavePaid) s.paidLeave = s.paidLeave.plus(amount);
      else s.unpaidLeave = s.unpaidLeave.plus(amount);
    };
    switch (r.status) {
      case "PRESENT":
        s.present += 1;
        break;
      case "LATE":
        s.late += 1;
        break;
      case "ABSENT":
        s.absent += 1;
        break;
      case "ON_LEAVE":
        leave(new Decimal(1));
        break;
      case "HALF_DAY":
        if (r.leaveRequestId !== null) leave(half);
        else s.halfDays += 1;
        break;
      default:
        s.unmarked += 1;
    }
  }
  s.lopDays = s.unpaidLeave.plus(s.absent).plus(half.times(s.halfDays));
  const monthEnd = days.length ? days[days.length - 1].date : today;
  s.complete = s.unmarked === 0 && !unknownLeave && monthEnd < today;
  return s;
}

export const PAYROLL_SUMMARY_HEADER = [
  "Employee ID", "Name", "Department", "Designation", "Month working days", "Not on rolls", "Working days", "Weekly offs", "Holidays", "Present", "Late",
  "Half days", "Paid leave", "Unpaid leave", "Absent", "Not marked", "LOP days", "Complete",
] as const;
