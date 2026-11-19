import type { Tx } from "@/lib/db";

/**
 * One transaction-scoped advisory lock for payroll (KI-081): run create / prepare / approve / reopen, salary propose /
 * decide / withdraw and the payroll day-basis setting all take it FIRST, so a salary can't change in a month that is
 * being prepared or approved at the same moment. One school, few writers.
 * Lock order: payroll (advisory) → leave calendar (advisory, run prepare / approve) → rows.
 */
export async function lockPayroll(tx: Tx): Promise<void> {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
  await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('school_erp.payroll'))) AS l`;
}
