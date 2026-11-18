import type { Tx } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

/**
 * Transaction helpers other modules call (PHASE_3_PLAN.md §6). No authorization here — the calling service has
 * authorized its own operation. Pure where-fragments are structural (no Prisma client import).
 */

/** H4 (owner-approved 2026-11-18): a class teacher's account must be linked to an ACTIVE, TEACHING employee. */
export const ELIGIBLE_CLASS_TEACHER_EMPLOYEE = { employmentStatus: "ACTIVE" as const, staffType: "TEACHING" as const, deletedAt: null };

/**
 * Locks the linked employee row FOR SHARE (a concurrent leaving or unlink — both take FOR UPDATE — waits) and
 * checks H4. Call it BEFORE locking the section: the documented lock order is employee → section/user, the same
 * first lock as an employee's leaving (employee FOR UPDATE → user → sections), so the two can't deadlock.
 */
export async function lockEligibleClassTeacherEmployee(tx: Tx, employeeId: string | null): Promise<void> {
  const refuse = (message: string) => new ValidationError(message, [{ path: "userId", message }]);
  if (!employeeId) throw refuse("This teacher's account isn't linked to a staff record. Link it on the teacher's Staff page first.");
  const [row] = await tx.$queryRaw<{ staff_type: string; employment_status: string }[]>`
    SELECT staff_type::text AS staff_type, employment_status::text AS employment_status
    FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR SHARE`;
  if (!row || row.staff_type !== ELIGIBLE_CLASS_TEACHER_EMPLOYEE.staffType || row.employment_status !== ELIGIBLE_CLASS_TEACHER_EMPLOYEE.employmentStatus) {
    throw refuse("Choose a teacher whose staff record is active and teaching.");
  }
}
