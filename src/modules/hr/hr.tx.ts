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

/** Phase 4A (AC4): a subject teacher is an ACTIVE, TEACHING employee with an active linked login (for SELF / scope). */
export const ALLOCATABLE_TEACHER_EMPLOYEE = {
  ...ELIGIBLE_CLASS_TEACHER_EMPLOYEE,
  user: { is: { isActive: true, deletedAt: null } },
};

/**
 * Locks the employee FOR SHARE, then its linked login FOR SHARE, and checks AC4. Same first lock as an employee's
 * leaving or unlink (employee FOR UPDATE → user), so the two serialize and can't deadlock. Call BEFORE academic locks.
 */
export async function lockAllocatableTeacher(tx: Tx, employeeId: string): Promise<void> {
  const refuse = (message: string) => new ValidationError(message, [{ path: "employeeId", message }]);
  const [row] = await tx.$queryRaw<{ staff_type: string; employment_status: string }[]>`
    SELECT staff_type::text AS staff_type, employment_status::text AS employment_status
    FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR SHARE`;
  if (!row || row.staff_type !== "TEACHING" || row.employment_status !== "ACTIVE") throw refuse("Choose a teacher whose staff record is active and teaching.");
  const users = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "user" WHERE employee_id = ${employeeId} AND is_active AND deleted_at IS NULL FOR SHARE`;
  if (users.length !== 1) throw refuse("This teacher has no active login linked to their staff record. Link one on the Staff page first.");
}
