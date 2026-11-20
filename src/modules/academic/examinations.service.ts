import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { masterNameKeyOf } from "@/modules/hr/hr.rules";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import { dateProblem, scaleEditable, subjectsEditable, transitionProblem, type ExamStatus } from "./examinations.rules";
import type { AddExamSubjectsInput, CreateExamInput, ExamStatusInput, ExamSubjectRefInput, UpdateExamInput, UpdateExamSubjectInput } from "./examinations.schemas";

/**
 * Phase 4B-M3 — examinations and their subjects (PHASE_4_PLAN.md AC9).
 * - Manage: `exam.manage` (School Admin, Principal). Read: `exam.manage` or `academic.read` at ALL.
 * - Never in a CLOSED session. Each exam has its own grading scale (active when chosen; changeable only in DRAFT).
 * - Subjects (date, maximum marks per part, pass percent) are edited only in DRAFT / SCHEDULED; a subject with a
 *   marks sheet can't be removed. Marks entry, locking and publishing belong to the marks / results services.
 * Lock order: academic_session FOR SHARE → grade_scale FOR SHARE → examination FOR UPDATE → class_subject FOR SHARE.
 * (grading.updateScale locks grade_scale FOR UPDATE, so scheduling an exam and editing its scale's bands serialize.)
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const day = (s: string | null) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const stale = () => new ConflictError("This exam was changed by someone else. Reload the page and try again.");
const busy = (e: unknown, name?: string): never => {
  if (isUniqueViolation(e, "nameKey")) throw new ConflictError(`An exam named "${name ?? "that"}" already exists in this session.`);
  if (isUniqueViolation(e)) throw new ConflictError("That subject is already in this exam.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

export function examAccess(ctx: AuthContext) {
  const manage = hasPermission(ctx, "exam.manage");
  return { manage, read: manage || (hasPermission(ctx, "academic.read") && scopeFor(ctx, "academic.read") === "ALL") };
}
function assertRead(ctx: AuthContext) {
  if (!examAccess(ctx).read) throw new ForbiddenError();
}

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

async function lockScaleActive(tx: Tx, scaleId: string) {
  const [s] = await tx.$queryRaw<{ is_active: boolean }[]>`SELECT is_active FROM grade_scale WHERE id = ${scaleId} FOR SHARE`;
  if (!s) throw new NotFoundError("Grading scale not found.");
  if (!s.is_active) throw new ConflictError("That grading scale is inactive. Choose an active scale.");
}

type ExamRow = { id: string; academic_session_id: string; status: ExamStatus; version: number; grade_scale_id: string; start_date: Date | null; end_date: Date | null };
async function lockExam(tx: Tx, id: string, version?: number): Promise<ExamRow> {
  const [row] = await tx.$queryRaw<ExamRow[]>`
    SELECT id, academic_session_id, status::text AS status, version, grade_scale_id, start_date, end_date FROM examination WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError("Exam not found.");
  if (version !== undefined && row.version !== version) throw stale();
  return row;
}

/** Locks session (shared) then the exam; refuses closed sessions. */
async function lockExamForChange(tx: Tx, id: string, version: number) {
  await lockTimeout(tx);
  const [peek] = await tx.$queryRaw<{ academic_session_id: string }[]>`SELECT academic_session_id FROM examination WHERE id = ${id}`;
  if (!peek) throw new NotFoundError("Exam not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.academic_session_id));
  return lockExam(tx, id, version);
}

async function bumpExam(tx: Tx, id: string) {
  await tx.examination.update({ where: { id }, data: { version: { increment: 1 } } });
}

export async function listExams(ctx: AuthContext, academicSessionId: string) {
  assertRead(ctx);
  return prisma.examination.findMany({
    where: { academicSessionId },
    orderBy: [{ startDate: { sort: "asc", nulls: "last" } }, { name: "asc" }],
    take: 100,
    select: { id: true, name: true, status: true, startDate: true, endDate: true, version: true, gradeScale: { select: { name: true } }, _count: { select: { subjects: true } } },
  });
}

export async function getExam(ctx: AuthContext, id: string) {
  assertRead(ctx);
  const exam = await prisma.examination.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      version: true,
      academicSession: { select: { id: true, name: true, status: true } },
      gradeScale: { select: { id: true, name: true } },
      subjects: {
        orderBy: [{ classSubject: { class: { displayOrder: "asc" } } }, { classSubject: { sortOrder: "asc" } }, { id: "asc" }],
        take: 500,
        select: {
          id: true,
          examDate: true,
          maxTheory: true,
          maxPractical: true,
          maxInternal: true,
          passPercent: true,
          version: true,
          classSubject: { select: { id: true, class: { select: { id: true, name: true } }, subject: { select: { name: true, code: true } } } },
          _count: { select: { sheets: true } },
        },
      },
    },
  });
  if (!exam) throw new NotFoundError("Exam not found.");
  return exam;
}

/** Class subjects of the exam's session not yet in the exam (the "add subjects" picker). */
export async function listAddableClassSubjects(ctx: AuthContext, examinationId: string) {
  authorize(ctx, "exam.manage");
  const exam = await prisma.examination.findUnique({ where: { id: examinationId }, select: { academicSessionId: true } });
  if (!exam) throw new NotFoundError("Exam not found.");
  return prisma.classSubject.findMany({
    where: { academicSessionId: exam.academicSessionId, examSubjects: { none: { examinationId } }, subject: { kind: "SCHOLASTIC" } },
    orderBy: [{ class: { displayOrder: "asc" } }, { sortOrder: "asc" }, { id: "asc" }],
    take: 500,
    select: { id: true, class: { select: { name: true } }, subject: { select: { name: true, code: true } } },
  });
}

export async function createExam(ctx: AuthContext, input: CreateExamInput) {
  authorize(ctx, "exam.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      assertSessionWritable(await lockSessionShared(tx, input.academicSessionId));
      await lockScaleActive(tx, input.gradeScaleId);
      const exam = await tx.examination.create({
        data: {
          academicSessionId: input.academicSessionId,
          name: input.name,
          nameKey: masterNameKeyOf(input.name),
          gradeScaleId: input.gradeScaleId,
          startDate: day(input.startDate),
          endDate: day(input.endDate),
        },
        select: { id: true, name: true },
      });
      await audit(tx, actorOf(ctx), { action: "examination.create", entityType: "Examination", entityId: exam.id, after: { name: input.name, academicSessionId: input.academicSessionId, gradeScaleId: input.gradeScaleId, startDate: input.startDate, endDate: input.endDate } });
      return exam;
    });
  } catch (e) {
    return busy(e, input.name);
  }
}

export async function updateExam(ctx: AuthContext, input: UpdateExamInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamForChange(tx, input.id, input.version);
      if (!subjectsEditable(exam.status)) throw new ConflictError("Marks entry has started, so the exam's details are fixed.");
      if (input.gradeScaleId !== exam.grade_scale_id) {
        if (!scaleEditable(exam.status)) throw new ConflictError("The grading scale can only be changed while the exam is a draft.");
        await lockScaleActive(tx, input.gradeScaleId);
      }
      const outside = await tx.examSubject.findFirst({
        where: {
          examinationId: input.id,
          OR: [...(input.startDate ? [{ examDate: { lt: day(input.startDate)! } }] : []), ...(input.endDate ? [{ examDate: { gt: day(input.endDate)! } }] : [])],
        },
        select: { id: true },
      });
      if ((input.startDate || input.endDate) && outside) throw new ConflictError("Some subjects are dated outside these exam dates. Change those dates first.");
      await tx.examination.update({
        where: { id: input.id },
        data: { name: input.name, nameKey: masterNameKeyOf(input.name), gradeScaleId: input.gradeScaleId, startDate: day(input.startDate), endDate: day(input.endDate), version: { increment: 1 } },
      });
      await audit(tx, actorOf(ctx), {
        action: "examination.update",
        entityType: "Examination",
        entityId: input.id,
        before: { gradeScaleId: exam.grade_scale_id, startDate: iso(exam.start_date), endDate: iso(exam.end_date) },
        after: { name: input.name, gradeScaleId: input.gradeScaleId, startDate: input.startDate, endDate: input.endDate },
      });
    });
  } catch (e) {
    busy(e, input.name);
  }
}

export async function setExamStatus(ctx: AuthContext, input: ExamStatusInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const [peek] = await tx.$queryRaw<{ academic_session_id: string; grade_scale_id: string }[]>`SELECT academic_session_id, grade_scale_id FROM examination WHERE id = ${input.id}`;
      if (!peek) throw new NotFoundError("Exam not found.");
      assertSessionWritable(await lockSessionShared(tx, peek.academic_session_id));
      if (input.to === "SCHEDULED") await lockScaleActive(tx, peek.grade_scale_id); // freezes the scale's bands (grading.updateScale)
      const exam = await lockExam(tx, input.id, input.version);
      const [subjectCount, marksCount] = await Promise.all([
        tx.examSubject.count({ where: { examinationId: input.id } }),
        tx.examinationMarks.count({ where: { sheet: { examSubject: { examinationId: input.id } } } }),
      ]);
      const problem = transitionProblem(exam.status, input.to, { subjectCount, marksCount });
      if (problem) throw new ConflictError(problem);
      await tx.examination.update({ where: { id: input.id }, data: { status: input.to, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "examination.status_change", entityType: "Examination", entityId: input.id, before: { status: exam.status }, after: { status: input.to } });
    });
  } catch (e) {
    busy(e);
  }
}

/** Hard delete is allowed only for a DRAFT exam (draft data — CLAUDE.md rule 9); its subjects go with it. */
export async function deleteExam(ctx: AuthContext, input: ExamSubjectRefInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamForChange(tx, input.id, input.version);
      if (exam.status !== "DRAFT") throw new ConflictError("Only a draft exam can be deleted.");
      if ((await tx.marksSheet.count({ where: { examSubject: { examinationId: input.id } } })) > 0) throw new ConflictError("Marks sheets exist for this exam, so it can't be deleted.");
      const removed = await tx.examSubject.deleteMany({ where: { examinationId: input.id } });
      await tx.examination.delete({ where: { id: input.id } });
      await audit(tx, actorOf(ctx), { action: "examination.delete", entityType: "Examination", entityId: input.id, before: { status: exam.status, subjects: removed.count } });
    });
  } catch (e) {
    busy(e);
  }
}

export async function addExamSubjects(ctx: AuthContext, input: AddExamSubjectsInput) {
  authorize(ctx, "exam.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const exam = await lockExamForChange(tx, input.examinationId, input.version);
      if (!subjectsEditable(exam.status)) throw new ConflictError("Marks entry has started, so subjects can't be added.");
      const dp = dateProblem(input.examDate, iso(exam.start_date), iso(exam.end_date));
      if (dp) throw new ValidationError(dp, [{ path: "examDate", message: dp }]);
      const ids = [...new Set(input.classSubjectIds)].sort();
      const rows = await tx.$queryRaw<{ id: string; academic_session_id: string; kind: string }[]>`
        SELECT cs.id, cs.academic_session_id, s.kind::text AS kind FROM class_subject cs JOIN subject s ON s.id = cs.subject_id
        WHERE cs.id = ANY(${ids}) ORDER BY cs.id FOR SHARE OF cs`;
      if (rows.length !== ids.length || rows.some((r) => r.academic_session_id !== exam.academic_session_id)) throw new NotFoundError("Class subject not found in this exam's session. Reload the page.");
      if (rows.some((r) => r.kind !== "SCHOLASTIC")) throw new ValidationError("Co-scholastic subjects are graded separately, not examined with marks.");
      const created = await tx.examSubject.createMany({
        data: ids.map((classSubjectId) => ({
          academicSessionId: exam.academic_session_id,
          examinationId: exam.id,
          classSubjectId,
          examDate: day(input.examDate),
          maxTheory: input.maxTheory,
          maxPractical: input.maxPractical,
          maxInternal: input.maxInternal,
          passPercent: input.passPercent,
        })),
      });
      await bumpExam(tx, exam.id);
      await audit(tx, actorOf(ctx), { action: "exam_subject.add", entityType: "Examination", entityId: exam.id, after: { count: created.count, maxTheory: input.maxTheory, maxPractical: input.maxPractical, maxInternal: input.maxInternal, passPercent: input.passPercent, examDate: input.examDate } });
      return created.count;
    });
  } catch (e) {
    return busy(e);
  }
}

async function lockExamSubject(tx: Tx, id: string, version: number) {
  await lockTimeout(tx);
  const [peek] = await tx.$queryRaw<{ examination_id: string; academic_session_id: string }[]>`SELECT examination_id, academic_session_id FROM exam_subject WHERE id = ${id}`;
  if (!peek) throw new NotFoundError("Exam subject not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.academic_session_id));
  const exam = await lockExam(tx, peek.examination_id);
  const [row] = await tx.$queryRaw<{ version: number }[]>`SELECT version FROM exam_subject WHERE id = ${id} FOR UPDATE`;
  if (!row) throw new NotFoundError("Exam subject not found.");
  if (row.version !== version) throw new ConflictError("This exam subject was changed by someone else. Reload the page and try again.");
  if (!subjectsEditable(exam.status)) throw new ConflictError("Marks entry has started, so the exam's subjects are fixed.");
  return exam;
}

export async function updateExamSubject(ctx: AuthContext, input: UpdateExamSubjectInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamSubject(tx, input.id, input.version);
      const dp = dateProblem(input.examDate, iso(exam.start_date), iso(exam.end_date));
      if (dp) throw new ValidationError(dp, [{ path: "examDate", message: dp }]);
      await tx.examSubject.update({
        where: { id: input.id },
        data: { examDate: day(input.examDate), maxTheory: input.maxTheory, maxPractical: input.maxPractical, maxInternal: input.maxInternal, passPercent: input.passPercent, version: { increment: 1 } },
      });
      await bumpExam(tx, exam.id);
      await audit(tx, actorOf(ctx), { action: "exam_subject.update", entityType: "ExamSubject", entityId: input.id, after: { examDate: input.examDate, maxTheory: input.maxTheory, maxPractical: input.maxPractical, maxInternal: input.maxInternal, passPercent: input.passPercent } });
    });
  } catch (e) {
    busy(e);
  }
}

export async function removeExamSubject(ctx: AuthContext, input: ExamSubjectRefInput) {
  authorize(ctx, "exam.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamSubject(tx, input.id, input.version);
      if ((await tx.marksSheet.count({ where: { examSubjectId: input.id } })) > 0) throw new ConflictError("Marks have been started for this subject, so it can't be removed.");
      await tx.examSubject.delete({ where: { id: input.id } });
      await bumpExam(tx, exam.id);
      await audit(tx, actorOf(ctx), { action: "exam_subject.remove", entityType: "ExamSubject", entityId: input.id, before: { examinationId: exam.id } });
    });
  } catch (e) {
    busy(e);
  }
}
