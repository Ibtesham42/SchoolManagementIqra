import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { ALLOCATABLE_TEACHER_EMPLOYEE } from "@/modules/hr/hr.tx";
import { assertSessionWritable } from "./academic.rules";
import { lockSessionShared } from "./academic.tx";
import {
  approverCanCorrect,
  entryProblem,
  lockProblems,
  markString,
  sameEntry,
  sheetActionProblem,
  teacherCanEdit,
  type ExamStatus,
  type MarkEntry,
  type Maxima,
  type RequiredSheet,
  type SheetStatus,
} from "./marks.rules";
import type { ExamRefInput, SaveMarksInput, SheetActionInput, SheetRefInput } from "./marks.schemas";

/**
 * Phase 4B-M4/M5 — marks entry, the marks-sheet workflow and locking an exam's marks (PHASE_4_PLAN.md AC10, AC13).
 *
 * Who (server-side; the screens only mirror this):
 * - Enter marks (`marks.enter`): ALL scope → any sheet; ASSIGNED → only the subject the teacher is ALLOCATED to in that
 *   section (TeacherAllocation.employeeId = the login's linked staff record, still an active teaching employee), in a
 *   session that isn't CLOSED (KI-077: this is the allocation-based widening of ASSIGNED, for marks only).
 * - Approve / return / correct approved marks / lock and unlock the exam's marks: `marks.approve` (Principal, Vice
 *   Principal). The approver never approves a sheet they submitted or ever saved marks on (AC13 maker-checker; audit history).
 * - Read a sheet: whoever may enter or approve it, `exam.manage`, `result.read` ALL, or the section's class teacher
 *   (`result.read` ASSIGNED). Anyone else gets NotFound (no oracle).
 * Roster: ACTIVE enrollments of the section whose student isn't deleted; for an optional subject only students who chose
 * it (StudentSubject).
 * Lock order: academic_session FOR SHARE → examination FOR SHARE (FOR UPDATE for lock / unlock; examinations.service
 * changes exam status FOR UPDATE, so a status change and a marks save serialize) → exam_subject FOR SHARE → section
 * FOR SHARE → teacher_allocation FOR SHARE → marks_sheet FOR UPDATE → examination_marks.
 * Audit rows carry counts and statuses — never marks or correction reasons.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const staleSheet = () => new ConflictError("These marks were changed by someone else. Reload the page and try again.");
const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("Someone else just started this marks sheet. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}

const scopeOf = (ctx: AuthContext, key: "marks.enter" | "marks.approve" | "result.read") => (hasPermission(ctx, key) ? scopeFor(ctx, key) : null);
const hasEmployee = (ctx: AuthContext): ctx is AuthContext & { employeeId: string } => typeof ctx.employeeId === "string" && ctx.employeeId !== "";

/** marks.approve at ALL (the catalog grants it unscoped). */
export const canApproveMarks = (ctx: AuthContext) => scopeOf(ctx, "marks.approve") === "ALL";

// ───────────────────────────── Sheet context ─────────────────────────────

type Db = Tx | typeof prisma;

async function sheetContext(db: Db, input: SheetRefInput) {
  const [es, section] = await Promise.all([
    db.examSubject.findUnique({
      where: { id: input.examSubjectId },
      select: {
        id: true,
        maxTheory: true,
        maxPractical: true,
        maxInternal: true,
        passPercent: true,
        examination: { select: { id: true, name: true, status: true, academicSessionId: true, academicSession: { select: { name: true, status: true } } } },
        classSubject: { select: { id: true, classId: true, isOptional: true, subject: { select: { name: true, code: true } }, class: { select: { name: true } } } },
      },
    }),
    db.section.findUnique({ where: { id: input.sectionId }, select: { id: true, code: true, classId: true, classTeacherId: true, academicSessionId: true } }),
  ]);
  // A section of another class or session is "not found", like any out-of-scope record.
  if (!es || !section || section.classId !== es.classSubject.classId || section.academicSessionId !== es.examination.academicSessionId) {
    throw new NotFoundError("Marks sheet not found.");
  }
  return { es, section };
}
type SheetCtx = Awaited<ReturnType<typeof sheetContext>>;

async function isAllocatedTeacher(db: Db, ctx: AuthContext, sc: SheetCtx): Promise<boolean> {
  if (!hasEmployee(ctx) || sc.es.examination.academicSession.status === "CLOSED") return false;
  const a = await db.teacherAllocation.findFirst({
    where: { sectionId: sc.section.id, classSubjectId: sc.es.classSubject.id, employeeId: ctx.employeeId, employee: ALLOCATABLE_TEACHER_EMPLOYEE },
    select: { id: true },
  });
  return a !== null;
}

async function sheetAccess(db: Db, ctx: AuthContext, sc: SheetCtx) {
  const enter = scopeOf(ctx, "marks.enter");
  const canEnter = enter === "ALL" || (enter === "ASSIGNED" && (await isAllocatedTeacher(db, ctx, sc)));
  const canApprove = canApproveMarks(ctx);
  const result = scopeOf(ctx, "result.read");
  const classTeacher = result === "ASSIGNED" && sc.section.classTeacherId === ctx.userId && sc.es.examination.academicSession.status !== "CLOSED";
  const canRead = canEnter || canApprove || hasPermission(ctx, "exam.manage") || result === "ALL" || classTeacher;
  return { canEnter, canApprove, canRead };
}

function rosterWhere(sc: SheetCtx) {
  return {
    sectionId: sc.section.id,
    status: "ACTIVE" as const,
    student: { deletedAt: null },
    ...(sc.es.classSubject.isOptional ? { subjects: { some: { classSubjectId: sc.es.classSubject.id } } } : {}),
  };
}

const maximaOf = (sc: SheetCtx): Maxima => ({ theory: sc.es.maxTheory, practical: sc.es.maxPractical, internal: sc.es.maxInternal });

type MarkRow = { status: "PRESENT" | "ABSENT" | "EXEMPT"; theory: { toString(): string } | null; practical: { toString(): string } | null; internal: { toString(): string } | null };
const entryOf = (m: MarkRow): MarkEntry => ({ status: m.status, theory: markString(m.theory), practical: markString(m.practical), internal: markString(m.internal) });
const blank = (e: MarkEntry) => e.status === "PRESENT" && e.theory === null && e.practical === null && e.internal === null;

/**
 * Review 4B L1: has this user ever saved marks on the sheet? `enteredById` is overwritten by every save, so the
 * maker-checker rule also reads the append-only audit rows (`marks.save` per sheet).
 */
async function actorContributed(db: Db, sheetId: string, userId: string): Promise<boolean> {
  const [current, history] = await Promise.all([
    db.examinationMarks.count({ where: { marksSheetId: sheetId, enteredById: userId } }),
    db.auditLog.count({ where: { entityType: "MarksSheet", entityId: sheetId, actorId: userId, action: "marks.save" } }),
  ]);
  return current + history > 0;
}

// ───────────────────────────── Reads ─────────────────────────────

/** One marks sheet with its roster, for the entry grid. Out of scope → NotFound. */
export async function getMarksSheet(ctx: AuthContext, input: SheetRefInput) {
  const sc = await sheetContext(prisma, input);
  const access = await sheetAccess(prisma, ctx, sc);
  if (!access.canRead) throw new NotFoundError("Marks sheet not found.");
  const [sheet, roster] = await Promise.all([
    prisma.marksSheet.findUnique({
      where: { examSubjectId_sectionId: { examSubjectId: sc.es.id, sectionId: sc.section.id } },
      select: {
        id: true,
        status: true,
        version: true,
        submittedAt: true,
        approvedAt: true,
        submittedById: true,
        submittedBy: { select: { displayName: true } },
        approvedBy: { select: { displayName: true } },
      },
    }),
    prisma.studentEnrollment.findMany({
      where: rosterWhere(sc),
      orderBy: [{ rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
      take: 200,
      select: { id: true, rollNumber: { select: { rollNumber: true } }, student: { select: { studentCode: true, fullName: true } } },
    }),
  ]);
  const marks = sheet
    ? await prisma.examinationMarks.findMany({
        where: { marksSheetId: sheet.id, enrollmentId: { in: roster.map((r) => r.id) } },
        select: { enrollmentId: true, status: true, theory: true, practical: true, internal: true, version: true, correctionReason: true },
      })
    : [];
  const byEnrollment = new Map(marks.map((m) => [m.enrollmentId, m]));
  const max = maximaOf(sc);
  const facts = { examStatus: sc.es.examination.status as ExamStatus, sheetStatus: (sheet?.status ?? null) as SheetStatus | null };
  const rows = roster.map((r) => {
    const m = byEnrollment.get(r.id);
    const entry = m ? entryOf(m) : null;
    return {
      enrollmentId: r.id,
      rollNumber: r.rollNumber?.rollNumber ?? null,
      studentCode: r.student.studentCode,
      fullName: r.student.fullName,
      mark: entry && m ? { ...entry, version: m.version, corrected: m.correctionReason !== null } : null,
      complete: entry !== null && entryProblem(entry, max, false) === null,
    };
  });
  const completeCount = rows.filter((r) => r.complete).length;
  const actorEntered = sheet ? await actorContributed(prisma, sheet.id, ctx.userId) : false;
  const canEdit = access.canEnter && teacherCanEdit(facts);
  const canCorrect = access.canApprove && approverCanCorrect(facts);
  const step = (action: "submit" | "return" | "approve") =>
    sheetActionProblem(action, { ...facts, rosterCount: rows.length, completeCount, actorSubmitted: sheet?.submittedById === ctx.userId, actorEntered }) === null;
  return {
    exam: { id: sc.es.examination.id, name: sc.es.examination.name, status: facts.examStatus, sessionName: sc.es.examination.academicSession.name },
    subject: { name: sc.es.classSubject.subject.name, code: sc.es.classSubject.subject.code, className: sc.es.classSubject.class.name, isOptional: sc.es.classSubject.isOptional },
    section: { id: sc.section.id, code: sc.section.code },
    examSubjectId: sc.es.id,
    max,
    passPercent: sc.es.passPercent === null ? null : sc.es.passPercent.toString(),
    sheet: sheet
      ? { status: sheet.status as SheetStatus, version: sheet.version, submittedAt: sheet.submittedAt, approvedAt: sheet.approvedAt, submittedBy: sheet.submittedBy?.displayName ?? null, approvedBy: sheet.approvedBy?.displayName ?? null }
      : null,
    rows,
    completeCount,
    canEdit,
    canCorrect,
    canSubmit: access.canEnter && sheet !== null && step("submit"),
    canApprove: access.canApprove && sheet !== null && step("approve"),
    canReturn: access.canApprove && sheet !== null && step("return"),
    /** Why approval isn't offered to an approver (e.g. they entered the marks). */
    approveBlocker:
      access.canApprove && sheet?.status === "SUBMITTED"
        ? sheetActionProblem("approve", { ...facts, rosterCount: rows.length, completeCount, actorSubmitted: sheet.submittedById === ctx.userId, actorEntered })
        : null,
  };
}

/**
 * The teacher's own marks sheets: allocated subjects × sections in exams that are in marks entry (or later, read-only).
 * ALL-scope enterers and approvers use the exam overview instead; approvers also get the sheets awaiting approval.
 */
export async function listMyMarksSheets(ctx: AuthContext) {
  const enter = scopeOf(ctx, "marks.enter");
  const approve = canApproveMarks(ctx);
  if (!enter && !approve) throw new ForbiddenError();
  const mine: { examSubjectId: string; sectionId: string; exam: string; examStatus: string; subject: string; className: string; sectionCode: string; sheetStatus: string | null }[] = [];
  if (enter === "ASSIGNED" && hasEmployee(ctx)) {
    const allocations = await prisma.teacherAllocation.findMany({
      where: { employeeId: ctx.employeeId, employee: ALLOCATABLE_TEACHER_EMPLOYEE, academicSession: { status: { not: "CLOSED" } } },
      take: 200,
      select: {
        sectionId: true,
        section: { select: { code: true } },
        classSubject: {
          select: {
            subject: { select: { name: true } },
            class: { select: { name: true } },
            examSubjects: {
              where: { examination: { status: { in: ["MARKS_ENTRY", "LOCKED", "PUBLISHED"] } } },
              take: 20,
              select: { id: true, examination: { select: { name: true, status: true } } },
            },
          },
        },
      },
    });
    for (const a of allocations) {
      for (const es of a.classSubject.examSubjects) {
        mine.push({ examSubjectId: es.id, sectionId: a.sectionId, exam: es.examination.name, examStatus: es.examination.status, subject: a.classSubject.subject.name, className: a.classSubject.class.name, sectionCode: a.section.code, sheetStatus: null });
      }
    }
    if (mine.length > 0) {
      const sheets = await prisma.marksSheet.findMany({
        where: { OR: mine.map((m) => ({ examSubjectId: m.examSubjectId, sectionId: m.sectionId })) },
        select: { examSubjectId: true, sectionId: true, status: true },
      });
      const st = new Map(sheets.map((s) => [`${s.examSubjectId}|${s.sectionId}`, s.status]));
      for (const m of mine) m.sheetStatus = st.get(`${m.examSubjectId}|${m.sectionId}`) ?? null;
    }
  }
  const awaiting = approve
    ? await prisma.marksSheet.findMany({
        where: { status: "SUBMITTED", examSubject: { examination: { status: "MARKS_ENTRY" } } },
        orderBy: { submittedAt: "asc" },
        take: 100,
        select: {
          examSubjectId: true,
          sectionId: true,
          submittedAt: true,
          section: { select: { code: true } },
          examSubject: { select: { examination: { select: { name: true } }, classSubject: { select: { subject: { select: { name: true } } } } } },
        },
      })
    : [];
  return {
    mine: mine.sort((a, b) => a.exam.localeCompare(b.exam) || a.sectionCode.localeCompare(b.sectionCode) || a.subject.localeCompare(b.subject)),
    awaiting: awaiting.map((s) => ({ examSubjectId: s.examSubjectId, sectionId: s.sectionId, submittedAt: s.submittedAt, sectionCode: s.section.code, exam: s.examSubject.examination.name, subject: s.examSubject.classSubject.subject.name })),
    linked: hasEmployee(ctx),
    enterScope: enter,
  };
}

// ───────────────────────────── Locks inside a write ─────────────────────────────

async function lockForSheetWrite(tx: Tx, ctx: AuthContext, input: SheetRefInput) {
  await lockTimeout(tx);
  const peek = await sheetContext(tx, input);
  // Review 4B L2: out-of-scope callers get NotFound before any lock or session check (no oracle, no lock holding).
  if (!(await sheetAccess(tx, ctx, peek)).canRead) throw new NotFoundError("Marks sheet not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.es.examination.academicSessionId));
  const [exam] = await tx.$queryRaw<{ status: ExamStatus }[]>`SELECT status::text AS status FROM examination WHERE id = ${peek.es.examination.id} FOR SHARE`;
  if (!exam) throw new NotFoundError("Marks sheet not found.");
  await tx.$queryRaw`SELECT id FROM exam_subject WHERE id = ${peek.es.id} FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM section WHERE id = ${peek.section.id} FOR SHARE`;
  // Review 4B L3: a concurrent change or removal of the subject's teacher (allocations.service, FOR UPDATE) waits.
  await tx.$queryRaw`SELECT id FROM teacher_allocation WHERE section_id = ${peek.section.id} AND class_subject_id = ${peek.es.classSubject.id} FOR SHARE`;
  // Re-read under the locks: maxima and exam status can't change now.
  const sc = await sheetContext(tx, input);
  const [sheet] = await tx.$queryRaw<{ id: string; status: SheetStatus; version: number; submitted_by_id: string | null }[]>`
    SELECT id, status::text AS status, version, submitted_by_id FROM marks_sheet WHERE exam_subject_id = ${sc.es.id} AND section_id = ${sc.section.id} FOR UPDATE`;
  return { sc, examStatus: exam.status, sheet: sheet ?? null };
}

// ───────────────────────────── Writes ─────────────────────────────

/**
 * Saves the grid in one transaction. The allocated teacher (sheet OPEN, exam in MARKS_ENTRY) may save partial work;
 * a `marks.approve` holder corrects an APPROVED sheet (exam not yet published) with complete marks and a reason.
 */
export async function saveMarks(ctx: AuthContext, input: SaveMarksInput) {
  if (!hasPermission(ctx, "marks.enter") && !hasPermission(ctx, "marks.approve")) throw new ForbiddenError();
  try {
    return await prisma.$transaction(async (tx) => {
      const { sc, examStatus, sheet } = await lockForSheetWrite(tx, ctx, input);
      const access = await sheetAccess(tx, ctx, sc);
      if (!access.canRead) throw new NotFoundError("Marks sheet not found.");
      const facts = { examStatus, sheetStatus: sheet?.status ?? null };
      const mode = access.canEnter && teacherCanEdit(facts) ? "enter" : access.canApprove && approverCanCorrect(facts) ? "correct" : null;
      if (!mode) {
        if (examStatus !== "MARKS_ENTRY" && examStatus !== "LOCKED") throw new ConflictError("The exam isn't open for marks entry.");
        if (sheet?.status === "SUBMITTED") throw new ConflictError("These marks are submitted and waiting for approval. Ask the approver to return them to make changes.");
        if (sheet?.status === "APPROVED") throw new ConflictError("These marks are approved. Only an approver can correct them, with a reason.");
        throw new ForbiddenError("You can't enter marks for this subject and section.");
      }
      if ((sheet?.version ?? null) !== input.sheetVersion) throw staleSheet();
      if (mode === "correct" && input.reason === "") throw new ValidationError("Give a reason for correcting approved marks.", [{ path: "reason", message: "Give a reason (at least 3 characters)." }]);

      const roster = await tx.studentEnrollment.findMany({ where: rosterWhere(sc), take: 200, select: { id: true, student: { select: { fullName: true } } } });
      const names = new Map(roster.map((r) => [r.id, r.student.fullName]));
      const existing = sheet
        ? await tx.examinationMarks.findMany({ where: { marksSheetId: sheet.id }, select: { id: true, enrollmentId: true, status: true, theory: true, practical: true, internal: true, version: true } })
        : [];
      const byEnrollment = new Map(existing.map((m) => [m.enrollmentId, m]));
      const max = maximaOf(sc);
      const issues: { path: string; message: string }[] = [];
      const writes: { enrollmentId: string; entry: MarkEntry; existingId: string | null }[] = [];
      for (const e of input.entries) {
        const name = names.get(e.enrollmentId);
        if (!name) throw new NotFoundError("A student on this sheet no longer takes this subject in this section. Reload the page.");
        const entry: MarkEntry = { status: e.status, theory: e.theory, practical: e.practical, internal: e.internal };
        const cur = byEnrollment.get(e.enrollmentId);
        if ((cur?.version ?? null) !== e.version) throw staleSheet();
        if (cur && sameEntry(entryOf(cur), entry)) continue;
        if (!cur && blank(entry)) continue; // nothing typed for this student yet
        const problem = entryProblem(entry, max, mode === "enter");
        if (problem) {
          issues.push({ path: `entries.${e.enrollmentId}`, message: `${name}: ${problem}` });
          continue;
        }
        writes.push({ enrollmentId: e.enrollmentId, entry, existingId: cur?.id ?? null });
      }
      if (issues.length > 0) throw new ValidationError(issues[0].message, issues.slice(0, 20));
      if (writes.length === 0) return { created: 0, changed: 0 };

      const sheetId =
        sheet?.id ??
        (
          await tx.marksSheet.create({
            data: { academicSessionId: sc.es.examination.academicSessionId, examSubjectId: sc.es.id, sectionId: sc.section.id },
            select: { id: true },
          })
        ).id;
      let created = 0;
      let changed = 0;
      for (const w of writes) {
        const data = {
          status: w.entry.status,
          theory: w.entry.theory,
          practical: w.entry.practical,
          internal: w.entry.internal,
          enteredById: ctx.userId,
          correctionReason: mode === "correct" ? input.reason : null,
        };
        if (w.existingId) {
          await tx.examinationMarks.update({ where: { id: w.existingId }, data: { ...data, version: { increment: 1 } } });
          changed += 1;
        } else {
          await tx.examinationMarks.create({ data: { ...data, academicSessionId: sc.es.examination.academicSessionId, marksSheetId: sheetId, enrollmentId: w.enrollmentId } });
          created += 1;
        }
      }
      if (sheet) await tx.marksSheet.update({ where: { id: sheetId }, data: { version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), {
        action: mode === "correct" ? "marks.correct" : "marks.save",
        entityType: "MarksSheet",
        entityId: sheetId,
        after: { examSubjectId: sc.es.id, sectionId: sc.section.id, created, changed, sheetStatus: sheet?.status ?? "OPEN", source: input.source ?? "grid" },
      });
      return { created, changed };
    });
  } catch (e) {
    return busy(e);
  }
}

/** submit (the entering teacher) · return / approve (`marks.approve`, AC13). */
export async function sheetAction(ctx: AuthContext, input: SheetActionInput) {
  if (!hasPermission(ctx, "marks.enter") && !hasPermission(ctx, "marks.approve")) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      const { sc, examStatus, sheet } = await lockForSheetWrite(tx, ctx, input);
      const access = await sheetAccess(tx, ctx, sc);
      if (!access.canRead || !sheet) throw new NotFoundError("Marks sheet not found.");
      if (input.action === "submit" ? !access.canEnter : !access.canApprove) throw new ForbiddenError();
      if (sheet.version !== input.sheetVersion) throw staleSheet();
      const roster = await tx.studentEnrollment.findMany({ where: rosterWhere(sc), take: 200, select: { id: true } });
      const marks = await tx.examinationMarks.findMany({
        where: { marksSheetId: sheet.id, enrollmentId: { in: roster.map((r) => r.id) } },
        select: { status: true, theory: true, practical: true, internal: true },
      });
      const max = maximaOf(sc);
      const completeCount = marks.filter((m) => entryProblem(entryOf(m), max, false) === null).length;
      const actorEntered = await actorContributed(tx, sheet.id, ctx.userId);
      const problem = sheetActionProblem(input.action, {
        examStatus,
        sheetStatus: sheet.status,
        rosterCount: roster.length,
        completeCount,
        actorSubmitted: sheet.submitted_by_id === ctx.userId,
        actorEntered,
      });
      if (problem) throw new ConflictError(problem);
      const now = new Date();
      const data =
        input.action === "submit"
          ? { status: "SUBMITTED" as const, submittedById: ctx.userId, submittedAt: now }
          : input.action === "return"
            ? { status: "OPEN" as const, submittedById: null, submittedAt: null }
            : { status: "APPROVED" as const, approvedById: ctx.userId, approvedAt: now };
      await tx.marksSheet.update({ where: { id: sheet.id }, data: { ...data, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), {
        action: `marks_sheet.${input.action}`,
        entityType: "MarksSheet",
        entityId: sheet.id,
        before: { status: sheet.status },
        after: { status: data.status, students: roster.length },
      });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Exam-wide: overview, lock, unlock ─────────────────────────────

type CoverageRow = { exam_subject_id: string; section_id: string; section_code: string; subject_name: string; class_name: string; roster: number; marked: number; sheet_status: SheetStatus | null };

/** Every exam subject × section that has students taking the subject, with its sheet state (raw SQL — one round trip). */
export async function sheetCoverage(db: Db, examinationId: string, academicSessionId: string): Promise<CoverageRow[]> {
  return db.$queryRaw<CoverageRow[]>`
    WITH es AS (
      SELECT es.id, cs.id AS cs_id, cs.class_id, cs.is_optional, sub.name AS subject_name, c.name AS class_name, c.display_order, cs.sort_order
      FROM exam_subject es
      JOIN class_subject cs ON cs.id = es.class_subject_id
      JOIN subject sub ON sub.id = cs.subject_id
      JOIN school_class c ON c.id = cs.class_id
      WHERE es.examination_id = ${examinationId}
    ), roster AS (
      SELECT es.id AS es_id, s.id AS section_id, e.id AS enrollment_id
      FROM es
      JOIN section s ON s.class_id = es.class_id AND s.academic_session_id = ${academicSessionId}
      JOIN student_enrollment e ON e.section_id = s.id AND e.status = 'ACTIVE'
      JOIN student st ON st.id = e.student_id AND st.deleted_at IS NULL
      WHERE NOT es.is_optional OR EXISTS (SELECT 1 FROM student_subject ss WHERE ss.enrollment_id = e.id AND ss.class_subject_id = es.cs_id)
    )
    SELECT r.es_id AS exam_subject_id, r.section_id, s.code AS section_code, es.subject_name, es.class_name,
           count(*)::int AS roster, count(m.id)::int AS marked, ms.status::text AS sheet_status
    FROM roster r
    JOIN es ON es.id = r.es_id
    JOIN section s ON s.id = r.section_id
    LEFT JOIN marks_sheet ms ON ms.exam_subject_id = r.es_id AND ms.section_id = r.section_id
    LEFT JOIN examination_marks m ON m.marks_sheet_id = ms.id AND m.enrollment_id = r.enrollment_id
    GROUP BY r.es_id, r.section_id, s.code, es.subject_name, es.class_name, es.display_order, es.sort_order, ms.status
    ORDER BY es.display_order, s.code, es.sort_order, es.subject_name
    LIMIT 2000`;
}

export function requiredSheets(rows: readonly CoverageRow[]): RequiredSheet[] {
  return rows.map((r) => ({
    label: `${r.section_code} ${r.subject_name}`,
    rosterCount: r.roster,
    sheet: r.sheet_status ? { status: r.sheet_status, markCount: r.marked } : null,
  }));
}

/** For the exam page: who sees the sheet overview and the lock / unlock buttons. */
export function examMarksAccess(ctx: AuthContext) {
  const approve = canApproveMarks(ctx);
  return { overview: approve || hasPermission(ctx, "exam.manage") || scopeOf(ctx, "result.read") === "ALL" || scopeOf(ctx, "marks.enter") === "ALL", lock: approve };
}

export async function getExamSheetOverview(ctx: AuthContext, examinationId: string) {
  if (!examMarksAccess(ctx).overview) throw new ForbiddenError();
  const exam = await prisma.examination.findUnique({ where: { id: examinationId }, select: { academicSessionId: true } });
  if (!exam) throw new NotFoundError("Exam not found.");
  const rows = await sheetCoverage(prisma, examinationId, exam.academicSessionId);
  return { rows, problems: lockProblems(requiredSheets(rows)) };
}

async function lockExamRow(tx: Tx, input: ExamRefInput) {
  await lockTimeout(tx);
  const [peek] = await tx.$queryRaw<{ academic_session_id: string }[]>`SELECT academic_session_id FROM examination WHERE id = ${input.id}`;
  if (!peek) throw new NotFoundError("Exam not found.");
  assertSessionWritable(await lockSessionShared(tx, peek.academic_session_id));
  const [exam] = await tx.$queryRaw<{ status: ExamStatus; version: number }[]>`SELECT status::text AS status, version FROM examination WHERE id = ${input.id} FOR UPDATE`;
  if (!exam) throw new NotFoundError("Exam not found.");
  if (exam.version !== input.version) throw new ConflictError("This exam was changed by someone else. Reload the page and try again.");
  return { ...exam, academicSessionId: peek.academic_session_id };
}

/** MARKS_ENTRY → LOCKED: every sheet that has students is approved and complete (`marks.approve`). */
export async function lockExamMarks(ctx: AuthContext, input: ExamRefInput) {
  if (!canApproveMarks(ctx)) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamRow(tx, input);
      if (exam.status !== "MARKS_ENTRY") throw new ConflictError("Only an exam in marks entry can be locked.");
      const rows = await sheetCoverage(tx, input.id, exam.academicSessionId);
      if (rows.length === 0) throw new ConflictError("No students take this exam's subjects yet.");
      const problems = lockProblems(requiredSheets(rows));
      if (problems.length > 0) throw new ConflictError(`Not every marks sheet is ready: ${problems.join(" ")}`);
      await tx.examination.update({ where: { id: input.id }, data: { status: "LOCKED", version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "examination.lock_marks", entityType: "Examination", entityId: input.id, before: { status: exam.status }, after: { status: "LOCKED", sheets: rows.length } });
    });
  } catch (e) {
    busy(e);
  }
}

/** LOCKED → MARKS_ENTRY before publication (e.g. a late admission needs marks). Approved sheets stay approved. */
export async function unlockExamMarks(ctx: AuthContext, input: ExamRefInput) {
  if (!canApproveMarks(ctx)) throw new ForbiddenError();
  try {
    await prisma.$transaction(async (tx) => {
      const exam = await lockExamRow(tx, input);
      if (exam.status !== "LOCKED") throw new ConflictError("Only a locked exam can be reopened for marks entry. Published results stay as published.");
      await tx.examination.update({ where: { id: input.id }, data: { status: "MARKS_ENTRY", version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "examination.unlock_marks", entityType: "Examination", entityId: input.id, before: { status: "LOCKED" }, after: { status: "MARKS_ENTRY" } });
    });
  } catch (e) {
    busy(e);
  }
}

export { lockExamRow as lockExamRowTx };
