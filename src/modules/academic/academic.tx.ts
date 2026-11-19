import type { Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { NotFoundError } from "@/lib/errors";

/**
 * Transaction-scoped helpers of the academic module, for use INSIDE a caller's transaction (sections
 * service, admissions). They lock or read academic rows but do not authorize — the calling service
 * has already called authorize() for its own operation. Lock order everywhere:
 *   academic_session FOR SHARE → school_class FOR SHARE → section FOR UPDATE/SHARE.
 */
export type AcademicSessionStatus = "PLANNED" | "ACTIVE" | "CLOSED";

/** FOR SHARE on the session row: serializes with a concurrent status change (an UPDATE of that row). */
export async function lockSessionShared(tx: Tx, sessionId: string): Promise<AcademicSessionStatus> {
  const rows = await tx.$queryRaw<{ status: AcademicSessionStatus }[]>`SELECT status::text AS status FROM academic_session WHERE id = ${sessionId} FOR SHARE`;
  if (rows.length === 0) throw new NotFoundError("Academic session not found.");
  return rows[0].status;
}

/** Session facts for admissions (after lockSessionShared). */
export async function sessionFacts(tx: Tx, sessionId: string) {
  const s = await tx.academicSession.findUnique({ where: { id: sessionId }, select: { id: true, name: true, startDate: true, endDate: true, status: true } });
  if (!s) throw new NotFoundError("Academic session not found.");
  return s;
}

/** FOR SHARE on the class row: serializes with deactivation and code changes. */
export async function lockClassShared(tx: Tx, classId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM school_class WHERE id = ${classId} FOR SHARE`;
  if (rows.length === 0) throw new NotFoundError("Class not found.");
  return tx.schoolClass.findUniqueOrThrow({ where: { id: classId }, select: { id: true, code: true, name: true, isActive: true, defaultSectionCapacity: true } });
}

/** Section facts for admissions (no lock; approval locks the section FOR UPDATE itself). */
export async function sectionFacts(tx: Tx, sectionId: string) {
  const s = await tx.section.findUnique({
    where: { id: sectionId },
    select: { id: true, academicSessionId: true, classId: true, name: true, code: true, capacity: true, isActive: true },
  });
  if (!s) throw new NotFoundError("Section not found.");
  return s;
}

/** ACTIVE student enrollments in a section (call under the section's row lock when it must not change). */
export async function activeEnrollmentCount(tx: Tx, sectionId: string): Promise<number> {
  return tx.studentEnrollment.count({ where: { sectionId, status: "ACTIVE" } });
}

/** ACTIVE enrollments per section, for capacity displays (read-only, no lock). */
export async function activeEnrollmentCounts(tx: Tx, sectionIds: string[]): Promise<Map<string, number>> {
  if (sectionIds.length === 0) return new Map();
  const rows = await tx.studentEnrollment.groupBy({ by: ["sectionId"], where: { sectionId: { in: sectionIds }, status: "ACTIVE" }, _count: { _all: true } });
  return new Map(rows.map((r) => [r.sectionId, r._count._all]));
}

/**
 * FOR UPDATE on the section row: enrollments into one section serialize here, so the ACTIVE count read
 * afterwards can't change before the caller's insert commits (capacity is exact under concurrency).
 */
export async function lockSectionForUpdate(tx: Tx, sectionId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM section WHERE id = ${sectionId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Section not found.");
  return sectionFacts(tx, sectionId);
}

/**
 * S-09: removes a user as class teacher of every section (any session) when they lose the roles that make
 * them eligible — otherwise a later role with ASSIGNED student.read (e.g. Transport Manager) would inherit
 * the section's students. Runs INSIDE the caller's transaction (identity has authorized the role change);
 * sections are row-locked, their version bumped and each removal audited.
 */
export async function releaseClassTeacherAssignments(tx: Tx, actor: AuditActor, userId: string, reason: "role_change" | "employee_left" = "role_change"): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM section WHERE class_teacher_id = ${userId} ORDER BY id FOR UPDATE`;
  for (const { id } of rows) {
    await tx.section.update({ where: { id }, data: { classTeacherId: null, version: { increment: 1 } } });
    await audit(tx, actor, { action: "section.class_teacher_unassign", entityType: "Section", entityId: id, before: { classTeacherId: userId }, after: { classTeacherId: null, reason } });
  }
  return rows.length;
}

/**
 * Phase 4A-M2: a class subject locked FOR UPDATE (serializes student-choice edits of one subject with each other and
 * with optional ↔ compulsory changes). Call after the session (FOR SHARE) and the section, per the lock order.
 */
export async function lockClassSubjectForChoices(tx: Tx, classSubjectId: string) {
  const rows = await tx.$queryRaw<{ id: string; academic_session_id: string; class_id: string; is_optional: boolean }[]>`
    SELECT id, academic_session_id, class_id, is_optional FROM class_subject WHERE id = ${classSubjectId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Class subject not found.");
  const r = rows[0];
  const subject = await tx.classSubject.findUniqueOrThrow({ where: { id: classSubjectId }, select: { subject: { select: { code: true } } } });
  return { id: r.id, academicSessionId: r.academic_session_id, classId: r.class_id, isOptional: r.is_optional, subjectCode: subject.subject.code };
}
