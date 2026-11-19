import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertSessionWritable } from "./academic.rules";
import { lockClassShared, lockSessionShared } from "./academic.tx";
import type {
  AddClassSubjectsInput,
  ClassSubjectRefInput,
  CopyClassSubjectsInput,
  ListClassSubjectsInput,
  UpdateClassSubjectInput,
} from "./class-subjects.schemas";

/**
 * Phase 4A-M2 — class subjects (PHASE_4_PLAN.md AC3): the subjects a class studies in one academic session, each
 * compulsory or optional (optional ones are chosen per student — StudentSubject).
 *
 * - Reads: `academic.read` at ALL (this is the school's teaching plan; teachers' own views come with allocations).
 * - Writes: `academic.manage`; never in a CLOSED session; only ACTIVE classes and subjects can be added.
 * - A mapping in use (student choices, teacher allocations, timetable slots) can't be removed, and an optional
 *   subject with student choices can't become compulsory (the choices would be silently meaningless).
 * Lock order (academic.tx): academic_session FOR SHARE → school_class FOR SHARE → subject FOR SHARE → class_subject.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_ROWS = 200;
const stale = () => new ConflictError("This class subject was changed by someone else. Reload the page and try again.");
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

function assertReadAll(ctx: AuthContext) {
  if (authorize(ctx, "academic.read") !== "ALL") throw new ForbiddenError();
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

const usageCounts = { select: { studentChoices: true, allocations: true, timetableSlots: true } } as const;

export async function listClassSubjects(ctx: AuthContext, input: ListClassSubjectsInput) {
  assertReadAll(ctx);
  const [session, cls, rows] = await Promise.all([
    prisma.academicSession.findUnique({ where: { id: input.academicSessionId }, select: { id: true, name: true, status: true } }),
    prisma.schoolClass.findUnique({ where: { id: input.classId }, select: { id: true, name: true, code: true, isActive: true } }),
    prisma.classSubject.findMany({
      where: { academicSessionId: input.academicSessionId, classId: input.classId },
      orderBy: [{ sortOrder: "asc" }, { subject: { name: "asc" } }, { id: "asc" }],
      take: MAX_ROWS,
      select: {
        id: true,
        isOptional: true,
        sortOrder: true,
        version: true,
        subject: { select: { id: true, code: true, name: true, kind: true, isActive: true } },
        _count: usageCounts,
      },
    }),
  ]);
  if (!session) throw new NotFoundError("Academic session not found.");
  if (!cls) throw new NotFoundError("Class not found.");
  return { session, class: cls, items: rows };
}

export async function addClassSubjects(ctx: AuthContext, input: AddClassSubjectsInput) {
  authorize(ctx, "academic.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      const cls = await lockClassShared(tx, input.classId);
      if (!cls.isActive) throw new ConflictError(`${cls.name} is inactive. Activate it before adding subjects.`);
      const ids = [...input.subjectIds].sort();
      const subjects = await tx.$queryRaw<{ id: string; code: string; is_active: boolean }[]>`
        SELECT id, code, is_active FROM subject WHERE id = ANY(${ids}) ORDER BY id FOR SHARE`;
      if (subjects.length !== ids.length) throw new NotFoundError("Subject not found. Reload the page and try again.");
      const inactive = subjects.find((s) => !s.is_active);
      if (inactive) throw new ValidationError(`Subject ${inactive.code} is inactive.`, [{ path: "subjectIds", message: "Inactive subjects can't be added." }]);
      const existing = await tx.classSubject.findMany({
        where: { academicSessionId: input.academicSessionId, classId: input.classId, subjectId: { in: ids } },
        select: { subject: { select: { code: true } } },
      });
      if (existing.length > 0) {
        throw new ConflictError(`${existing.map((e) => e.subject.code).join(", ")} ${existing.length === 1 ? "is" : "are"} already in this class.`);
      }
      const max = await tx.classSubject.aggregate({ where: { academicSessionId: input.academicSessionId, classId: input.classId }, _max: { sortOrder: true } });
      let order = Math.min((max._max.sortOrder ?? -1) + 1, 999);
      const created = [];
      for (const s of subjects) {
        created.push(
          await tx.classSubject.create({
            data: { academicSessionId: input.academicSessionId, classId: input.classId, subjectId: s.id, isOptional: input.isOptional, sortOrder: order },
            select: { id: true },
          }),
        );
        order = Math.min(order + 1, 999);
      }
      await audit(tx, actorOf(ctx), {
        action: "class_subject.add",
        entityType: "SchoolClass",
        entityId: input.classId,
        after: { academicSessionId: input.academicSessionId, subjects: subjects.map((s) => s.code), isOptional: input.isOptional },
      });
      return { added: created.length };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ConflictError("One of these subjects was just added by someone else. Reload the page and try again.");
    return busy(e);
  }
}

async function lockClassSubject(tx: Tx, id: string) {
  const peek = await tx.classSubject.findUnique({ where: { id }, select: { academicSessionId: true, classId: true } });
  if (!peek) throw new NotFoundError("Class subject not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.academicSessionId));
  await lockClassShared(tx, peek.classId);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM class_subject WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Class subject not found.");
  return tx.classSubject.findUniqueOrThrow({
    where: { id },
    select: { id: true, academicSessionId: true, classId: true, isOptional: true, sortOrder: true, version: true, subject: { select: { code: true } }, _count: usageCounts },
  });
}

export async function updateClassSubject(ctx: AuthContext, input: UpdateClassSubjectInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const cur = await lockClassSubject(tx, input.id);
      if (cur.version !== input.version) throw stale();
      if (cur.isOptional === input.isOptional && cur.sortOrder === input.sortOrder) return;
      if (cur.isOptional && !input.isOptional && cur._count.studentChoices > 0) {
        throw new ConflictError(`${cur._count.studentChoices} student(s) chose ${cur.subject.code}. Remove their choices before making it compulsory.`);
      }
      const r = await tx.classSubject.updateMany({
        where: { id: input.id, version: input.version },
        data: { isOptional: input.isOptional, sortOrder: input.sortOrder, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "class_subject.update",
        entityType: "ClassSubject",
        entityId: input.id,
        before: { isOptional: cur.isOptional, sortOrder: cur.sortOrder },
        after: { isOptional: input.isOptional, sortOrder: input.sortOrder },
      });
    });
  } catch (e) {
    busy(e);
  }
}

/** Configuration, not history: removable (hard delete) only while nothing uses it. */
export async function removeClassSubject(ctx: AuthContext, input: ClassSubjectRefInput) {
  authorize(ctx, "academic.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const cur = await lockClassSubject(tx, input.id);
      if (cur.version !== input.version) throw stale();
      const used = cur._count.studentChoices + cur._count.allocations + cur._count.timetableSlots;
      if (used > 0) {
        throw new ConflictError(`${cur.subject.code} is in use (student choices, teacher allocations or the timetable). Remove those first.`);
      }
      await tx.classSubject.delete({ where: { id: input.id } });
      await audit(tx, actorOf(ctx), {
        action: "class_subject.remove",
        entityType: "ClassSubject",
        entityId: input.id,
        before: { academicSessionId: cur.academicSessionId, classId: cur.classId, subject: cur.subject.code, isOptional: cur.isOptional },
      });
    });
  } catch (e) {
    busy(e);
  }
}

/**
 * Copy every class-subject mapping of one session into another (e.g. last year's plan into the new session). Only
 * active classes and subjects; mappings that already exist are kept (skipped). Never into a CLOSED session.
 */
export async function copyClassSubjects(ctx: AuthContext, input: CopyClassSubjectsInput) {
  authorize(ctx, "academic.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      // Both sessions FOR SHARE in a fixed (id) order so two opposite copies can't deadlock.
      const [a, b] = [input.fromSessionId, input.toSessionId].sort();
      const statuses = new Map([
        [a, await lockSessionShared(tx, a)],
        [b, await lockSessionShared(tx, b)],
      ]);
      assertSessionWritable(statuses.get(input.toSessionId)!);
      const source = await tx.classSubject.findMany({
        where: { academicSessionId: input.fromSessionId, class: { isActive: true }, subject: { isActive: true } },
        select: { classId: true, subjectId: true, isOptional: true, sortOrder: true },
        take: 5000,
      });
      if (source.length === 0) return { created: 0, skipped: 0 };
      const created = await tx.classSubject.createMany({
        data: source.map((s) => ({ ...s, academicSessionId: input.toSessionId })),
        skipDuplicates: true,
      });
      await audit(tx, actorOf(ctx), {
        action: "class_subject.copy",
        entityType: "AcademicSession",
        entityId: input.toSessionId,
        after: { fromSessionId: input.fromSessionId, created: created.count, skipped: source.length - created.count },
      });
      return { created: created.count, skipped: source.length - created.count };
    });
  } catch (e) {
    return busy(e);
  }
}
