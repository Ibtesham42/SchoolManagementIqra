import type { Tx } from "@/lib/db";
import type { AuditActor } from "@/lib/audit";
import { ConflictError } from "@/lib/errors";
import { deactivateStudentPortalAccountsTx } from "@/modules/identity/portal-accounts.tx";

/**
 * Phase 6C-M4 (review M1, owner decision 2026-11-26): a student account stays usable only while it is still eligible
 * (P14). These helpers switch accounts off when a condition stops holding — the school setting, the minimum class or
 * the last consenting parent. No authorization: the caller authorized its own operation. Leaving is handled by
 * `deactivateStudentAccountOnLeavingTx` under the student lock.
 */

/** Upper bound for one settings change (one school: far above its student count). */
const MAX_SWEEP = 10_000;

/**
 * After the portal settings changed (the caller holds the school_setting row lock): with student accounts off, every
 * active student account goes; otherwise those whose current class is below the minimum. Returns how many.
 */
export async function deactivateIneligibleStudentAccountsTx(
  tx: Tx,
  actor: AuditActor,
  settings: { studentAccounts: boolean; studentMinClassLevel: number },
): Promise<number> {
  const accounts = await tx.user.findMany({
    where: { isActive: true, deletedAt: null, studentId: { not: null }, guardianId: null, employeeId: null },
    take: MAX_SWEEP,
    orderBy: { id: "asc" },
    select: {
      id: true,
      student: {
        select: {
          enrollments: {
            where: { status: "ACTIVE" },
            orderBy: { academicSession: { startDate: "desc" } },
            take: 1,
            select: { section: { select: { class: { select: { numericLevel: true } } } } },
          },
        },
      },
    },
  });
  // Review L-C: never stop silently at the bound — the settings change rolls back instead.
  if (accounts.length === MAX_SWEEP) throw new ConflictError("Too many student accounts to switch off in one change. Contact support.");
  const reason = settings.studentAccounts ? "below_min_class" : "student_accounts_off";
  const ids = settings.studentAccounts
    ? accounts.filter((a) => (a.student?.enrollments[0]?.section.class.numericLevel ?? -1) < settings.studentMinClassLevel).map((a) => a.id)
    : accounts.map((a) => a.id);
  return deactivateStudentPortalAccountsTx(tx, actor, ids, reason);
}

/**
 * After a parent lost access to these students (account switched off, or blocked from one child): each student whose
 * own account no longer has an activated, unblocked, consenting parent loses it. The student account is locked BEFORE
 * the parents are read, so two parents switched off at the same moment are serialised and the second sees the first.
 * Lock order: the caller holds student / guardian locks; only user rows are locked here (student → guardian → user).
 */
export async function deactivateOrphanedStudentAccountsTx(tx: Tx, actor: AuditActor, studentIds: string[]): Promise<number> {
  if (studentIds.length === 0) return 0;
  const locked = await tx.$queryRaw<{ id: string; student_id: string }[]>`
    SELECT id, student_id FROM "user"
    WHERE student_id = ANY(${studentIds}) AND deleted_at IS NULL AND is_active AND guardian_id IS NULL AND employee_id IS NULL
    ORDER BY id FOR UPDATE`;
  if (locked.length === 0) return 0;
  const stillCovered = await tx.studentGuardian.findMany({
    where: {
      studentId: { in: locked.map((r) => r.student_id) },
      portalAccess: true,
      guardian: { deletedAt: null, account: { is: { isActive: true, deletedAt: null, privacyConsentAt: { not: null } } } },
    },
    select: { studentId: true },
  });
  const covered = new Set(stillCovered.map((l) => l.studentId));
  const orphaned = locked.filter((r) => !covered.has(r.student_id)).map((r) => r.id);
  return deactivateStudentPortalAccountsTx(tx, actor, orphaned, "no_consenting_parent");
}
