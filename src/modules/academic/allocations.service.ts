import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { ALLOCATABLE_TEACHER_EMPLOYEE, lockAllocatableTeacher } from "@/modules/hr/hr.tx";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import type { AllocationRefInput, AssignTeacherInput, SectionAllocationsInput } from "./allocations.schemas";

/**
 * Phase 4A-M2 — teacher allocation (PHASE_4_PLAN.md AC4): who teaches each class subject in a section.
 *
 * - One teacher per subject per section (unique). The teacher is an ACTIVE, TEACHING employee with an active linked
 *   login (hr.tx `lockAllocatableTeacher`, checked under locks).
 * - Reads `academic.read` at ALL; writes `academic.manage`; never in a CLOSED session.
 * - A change of teacher, or removal, is refused while timetable slots of that section and subject name the current
 *   teacher (the timetable would silently point at the wrong person).
 * - Allocations don't change anyone's access yet: ASSIGNED scope still means class-teacher sections. Widening it to
 *   allocated sections comes with the screens that need it (teacher timetable, marks entry) and their security review.
 *
 * Lock order: employee (FOR SHARE) → user → academic_session (FOR SHARE) → section (FOR SHARE) → class_subject
 * (FOR SHARE) → teacher_allocation (FOR UPDATE). Same first lock as an employee's leaving (employee FOR UPDATE).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const stale = () => new ConflictError("This allocation was changed by someone else. Reload the page and try again.");
const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("Someone else just allocated a teacher to this subject. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

function assertReadAll(ctx: AuthContext) {
  if (authorize(ctx, "academic.read") !== "ALL") throw new ForbiddenError();
}

/** The section's class subjects for its session, each with its allocated teacher (if any). */
export async function listSectionAllocations(ctx: AuthContext, input: SectionAllocationsInput) {
  assertReadAll(ctx);
  const section = await prisma.section.findUnique({
    where: { id: input.sectionId },
    select: {
      id: true,
      code: true,
      name: true,
      classId: true,
      academicSessionId: true,
      class: { select: { name: true } },
      academicSession: { select: { name: true, status: true } },
    },
  });
  if (!section) throw new NotFoundError("Section not found.");
  const [subjects, allocations] = await Promise.all([
    prisma.classSubject.findMany({
      where: { academicSessionId: section.academicSessionId, classId: section.classId },
      orderBy: [{ sortOrder: "asc" }, { subject: { name: "asc" } }, { id: "asc" }],
      take: 200,
      select: { id: true, isOptional: true, subject: { select: { code: true, name: true } } },
    }),
    prisma.teacherAllocation.findMany({
      where: { sectionId: section.id },
      take: 200,
      select: {
        id: true,
        classSubjectId: true,
        version: true,
        employee: { select: { id: true, employeeCode: true, fullName: true, employmentStatus: true, staffType: true, deletedAt: true } },
      },
    }),
  ]);
  const byCs = new Map(allocations.map((a) => [a.classSubjectId, a]));
  return {
    section,
    items: subjects.map((cs) => {
      const a = byCs.get(cs.id);
      return {
        classSubjectId: cs.id,
        subject: cs.subject,
        isOptional: cs.isOptional,
        allocation: a
          ? {
              id: a.id,
              version: a.version,
              employeeId: a.employee.id,
              employeeCode: a.employee.employeeCode,
              fullName: a.employee.fullName,
              // A teacher who has since left (or stopped teaching) shows as needing a replacement.
              current: a.employee.deletedAt === null && a.employee.employmentStatus === "ACTIVE" && a.employee.staffType === "TEACHING",
            }
          : null,
      };
    }),
  };
}

/** The teacher picker (AC4): active teaching employees with an active linked login. */
export async function listAllocatableTeachers(ctx: AuthContext) {
  authorize(ctx, "academic.manage");
  return prisma.employee.findMany({
    where: ALLOCATABLE_TEACHER_EMPLOYEE,
    orderBy: [{ fullName: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, employeeCode: true, fullName: true, designation: { select: { name: true } } },
  });
}

async function slotsNamingTeacher(tx: Tx, sectionId: string, classSubjectId: string, employeeId: string) {
  return tx.timetableSlot.count({ where: { sectionId, classSubjectId, employeeId } });
}

export async function assignTeacher(ctx: AuthContext, input: AssignTeacherInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockAllocatableTeacher(tx, input.employeeId);
      const peek = await tx.section.findUnique({ where: { id: input.sectionId }, select: { academicSessionId: true } });
      if (!peek) throw new NotFoundError("Section not found.");
      assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
      const [sec] = await tx.$queryRaw<{ class_id: string; is_active: boolean }[]>`
        SELECT class_id, is_active FROM section WHERE id = ${input.sectionId} FOR SHARE`;
      if (!sec) throw new NotFoundError("Section not found.");
      if (!sec.is_active) throw new ConflictError("This section is inactive.");
      const [cs] = await tx.$queryRaw<{ class_id: string; academic_session_id: string }[]>`
        SELECT class_id, academic_session_id FROM class_subject WHERE id = ${input.classSubjectId} FOR SHARE`;
      if (!cs || cs.class_id !== sec.class_id || cs.academic_session_id !== peek.academicSessionId) {
        throw new ValidationError("This subject isn't taught in this section's class this session.", [{ path: "classSubjectId", message: "Not a subject of this class." }]);
      }
      const [existing] = await tx.$queryRaw<{ id: string; employee_id: string; version: number }[]>`
        SELECT id, employee_id, version FROM teacher_allocation
        WHERE section_id = ${input.sectionId} AND class_subject_id = ${input.classSubjectId} FOR UPDATE`;
      if (!existing) {
        if (input.version !== null) throw stale();
        const created = await tx.teacherAllocation.create({
          data: { academicSessionId: peek.academicSessionId, sectionId: input.sectionId, classSubjectId: input.classSubjectId, employeeId: input.employeeId },
          select: { id: true },
        });
        await audit(tx, actorOf(ctx), {
          action: "teacher_allocation.assign",
          entityType: "TeacherAllocation",
          entityId: created.id,
          after: { sectionId: input.sectionId, classSubjectId: input.classSubjectId, employeeId: input.employeeId },
        });
        return;
      }
      if (input.version !== existing.version) throw stale();
      if (existing.employee_id === input.employeeId) return;
      if ((await slotsNamingTeacher(tx, input.sectionId, input.classSubjectId, existing.employee_id)) > 0) {
        throw new ConflictError("The timetable still names the current teacher for this subject. Update the timetable first.");
      }
      const r = await tx.teacherAllocation.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { employeeId: input.employeeId, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "teacher_allocation.change",
        entityType: "TeacherAllocation",
        entityId: existing.id,
        before: { employeeId: existing.employee_id },
        after: { employeeId: input.employeeId },
      });
    });
  } catch (e) {
    busy(e);
  }
}

/** Removal is allowed in CLOSED sessions too (it only reduces what a teacher is linked to), like class teachers (S-02). */
export async function removeAllocation(ctx: AuthContext, input: AllocationRefInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const peek = await tx.teacherAllocation.findUnique({ where: { id: input.id }, select: { academicSessionId: true } });
      if (!peek) throw new NotFoundError("Allocation not found.");
      await lockSessionShared(tx, peek.academicSessionId);
      const [row] = await tx.$queryRaw<{ id: string; section_id: string; class_subject_id: string; employee_id: string; version: number }[]>`
        SELECT id, section_id, class_subject_id, employee_id, version FROM teacher_allocation WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new NotFoundError("Allocation not found.");
      if (row.version !== input.version) throw stale();
      if ((await slotsNamingTeacher(tx, row.section_id, row.class_subject_id, row.employee_id)) > 0) {
        throw new ConflictError("The timetable still names this teacher for this subject. Update the timetable first.");
      }
      await tx.teacherAllocation.delete({ where: { id: row.id } });
      await audit(tx, actorOf(ctx), {
        action: "teacher_allocation.remove",
        entityType: "TeacherAllocation",
        entityId: row.id,
        before: { sectionId: row.section_id, classSubjectId: row.class_subject_id, employeeId: row.employee_id },
      });
    });
  } catch (e) {
    busy(e);
  }
}
