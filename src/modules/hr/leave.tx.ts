import type { Tx } from "@/lib/db";
import { STAFF_HOLIDAY_SCOPES } from "./leave.rules";

/**
 * Phase 3B transaction helpers (no authorization — the calling service authorized its operation).
 *
 * KI-071 (3B-M2 audit F5): every write whose correctness depends on the staff calendar — holiday create/remove,
 * leave apply / approve / cancel — takes ONE transaction-scoped advisory lock FIRST, so a holiday can't appear or
 * vanish between "count the working days" and "store the request". One school, few writers: a single key is enough.
 *
 * Lock order (all Phase 3B writers): leave calendar (advisory) → employee → leave_request → leave_type →
 * academic_session → leave_balance → employee_attendance / holiday. Opening balances skip the calendar lock (they
 * don't depend on it) but follow the same order from employee on, so the orders never invert. Staff-attendance
 * marking (3B-M4) follows it too: calendar → employee (FOR SHARE, sorted ids) → academic_session (FOR SHARE) →
 * employee_attendance. A payroll month-lock writer (3C) must take the calendar lock first.
 */
export async function lockLeaveCalendar(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.leave_calendar'))) AS l`;
}

export async function setLockTimeout(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Staff holidays (everyone + staff-only) between two ISO dates inclusive, as a set of ISO dates. */
export async function staffHolidaysBetween(
  tx: Tx,
  from: string,
  to: string,
): Promise<Set<string>> {
  const rows = await tx.holiday.findMany({
    where: {
      date: { gte: day(from), lte: day(to) },
      appliesTo: { in: [...STAFF_HOLIDAY_SCOPES] },
    },
    select: { date: true },
    take: 400,
  });
  return new Set(rows.map((r) => iso(r.date)));
}

/** L8: months (first day, ISO) in the range that payroll has locked. */
export async function lockedMonthsBetween(
  tx: Tx,
  from: string,
  to: string,
): Promise<string[]> {
  const first = day(`${from.slice(0, 7)}-01`);
  const rows = await tx.attendancePeriodLock.findMany({
    where: { month: { gte: first, lte: day(to) } },
    select: { month: true },
    take: 24,
  });
  return rows.map((r) => iso(r.month));
}
