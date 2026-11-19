import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "@/modules/academic/academic.rules";
import { lockClassSubjectForChoices, lockSessionShared } from "@/modules/academic/academic.tx";
import type { SectionChoicesInput, SetSubjectChoicesInput } from "./subject-choices.schemas";

/**
 * Phase 4A-M2 — optional subjects per student (PHASE_4_PLAN.md AC3). The students module owns enrollments; the
 * academic module's tx helpers lock the session and the class subject.
 *
 * - Reads (the section roster with choices): `academic.read` AND `student.read`, both at ALL (school-wide planning;
 *   class teachers get their own view when ASSIGNED scope widens — KI-077).
 * - Writes: `academic.manage`. One save sets exactly who takes ONE optional subject in ONE section; only ACTIVE
 *   enrollments of that section; never in a CLOSED session; compulsory subjects have no choices.
 * Lock order: academic_session (FOR SHARE) → section (FOR SHARE) → class_subject (FOR UPDATE) → student_enrollment
 * (FOR SHARE) → student_subject.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_STUDENTS = 200;

function assertReadAll(ctx: AuthContext) {
  if (authorize(ctx, "academic.read") !== "ALL" || authorize(ctx, "student.read") !== "ALL") throw new ForbiddenError();
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

export async function getSectionChoices(ctx: AuthContext, input: SectionChoicesInput) {
  assertReadAll(ctx);
  const section = await prisma.section.findUnique({
    where: { id: input.sectionId },
    select: { id: true, code: true, classId: true, academicSessionId: true, academicSession: { select: { name: true, status: true } } },
  });
  if (!section) throw new NotFoundError("Section not found.");
  const [subjects, roster] = await Promise.all([
    prisma.classSubject.findMany({
      where: { academicSessionId: section.academicSessionId, classId: section.classId, isOptional: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      take: 100,
      select: { id: true, subject: { select: { code: true, name: true } }, studentChoices: { where: { enrollment: { sectionId: section.id, status: "ACTIVE", student: { deletedAt: null } } }, select: { enrollmentId: true } } },
    }),
    prisma.studentEnrollment.findMany({
      where: { sectionId: section.id, status: "ACTIVE", student: { deletedAt: null } },
      orderBy: [{ rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
      take: MAX_STUDENTS,
      select: { id: true, rollNumber: { select: { rollNumber: true } }, student: { select: { studentCode: true, fullName: true } } },
    }),
  ]);
  return {
    section,
    subjects: subjects.map((s) => ({ id: s.id, code: s.subject.code, name: s.subject.name, chosen: s.studentChoices.map((c) => c.enrollmentId) })),
    roster: roster.map((e) => ({ enrollmentId: e.id, rollNumber: e.rollNumber?.rollNumber ?? null, studentCode: e.student.studentCode, fullName: e.student.fullName })),
  };
}

export async function setSubjectChoices(ctx: AuthContext, input: SetSubjectChoicesInput) {
  authorize(ctx, "academic.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const peek = await tx.section.findUnique({ where: { id: input.sectionId }, select: { academicSessionId: true } });
      if (!peek) throw new NotFoundError("Section not found.");
      assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
      const [sec] = await tx.$queryRaw<{ class_id: string }[]>`SELECT class_id FROM section WHERE id = ${input.sectionId} FOR SHARE`;
      if (!sec) throw new NotFoundError("Section not found.");
      const cs = await lockClassSubjectForChoices(tx, input.classSubjectId);
      if (cs.academicSessionId !== peek.academicSessionId || cs.classId !== sec.class_id) {
        throw new ValidationError("This subject isn't taught in this section's class this session.", [{ path: "classSubjectId", message: "Not a subject of this class." }]);
      }
      if (!cs.isOptional) throw new ConflictError(`${cs.subjectCode} is compulsory: every student takes it, so there is nothing to choose.`);

      const active = await tx.$queryRaw<{ id: string }[]>`
        SELECT e.id FROM student_enrollment e JOIN student s ON s.id = e.student_id
        WHERE e.section_id = ${input.sectionId} AND e.status = 'ACTIVE' AND s.deleted_at IS NULL
        ORDER BY e.id FOR SHARE OF e`;
      const activeIds = new Set(active.map((a) => a.id));
      const stray = input.enrollmentIds.find((id) => !activeIds.has(id));
      if (stray) throw new ConflictError("A student on this screen is no longer in this section. Reload the page and try again.");

      const current = await tx.studentSubject.findMany({
        where: { classSubjectId: cs.id, enrollmentId: { in: [...activeIds] } },
        select: { id: true, enrollmentId: true },
      });
      const want = new Set(input.enrollmentIds);
      const have = new Set(current.map((c) => c.enrollmentId));
      const expected = new Set(input.expectedIds);
      if (expected.size !== have.size || [...have].some((id) => !expected.has(id))) {
        throw new ConflictError("These choices were changed by someone else. Reload the page and try again.");
      }
      const add = input.enrollmentIds.filter((id) => !have.has(id));
      const remove = current.filter((c) => !want.has(c.enrollmentId)).map((c) => c.id);
      if (add.length === 0 && remove.length === 0) return { added: 0, removed: 0 };
      if (add.length > 0) {
        await tx.studentSubject.createMany({ data: add.map((enrollmentId) => ({ academicSessionId: peek.academicSessionId, enrollmentId, classSubjectId: cs.id })) });
      }
      if (remove.length > 0) await tx.studentSubject.deleteMany({ where: { id: { in: remove } } });
      // Ids and counts only (no names).
      await audit(tx, actorOf(ctx), {
        action: "student_subject.set",
        entityType: "ClassSubject",
        entityId: cs.id,
        after: { sectionId: input.sectionId, subject: cs.subjectCode, added: add, removedCount: remove.length, total: input.enrollmentIds.length },
      });
      return { added: add.length, removed: remove.length };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("These choices were just changed by someone else. Reload the page and try again.");
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
}
