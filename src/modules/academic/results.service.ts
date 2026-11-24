import { createElement } from "react";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { renderPdf } from "@/lib/pdf/render";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { loadBranding } from "@/modules/documents/documents.service";
import { ReportCardDocument } from "@/modules/documents/templates/report-card";
import { afterCommit, type NotificationDraft } from "@/modules/notifications/notifications.service";
import { readResultSettingsTx } from "@/modules/settings/settings.service";
import { familyRecipientsOf } from "@/modules/students/family-recipients.tx";
import { rankByPercent, type GradeBand, type OverallResult } from "./grade-calc";
import { lockExamRowTx, requiredSheets, sheetCoverage } from "./marks.service";
import { lockProblems, markString, type MarkEntry } from "./marks.rules";
import type { ExamRefInput, ReportCardRemarkInput, SectionResultsInput } from "./marks.schemas";
import { attendancePercent, buildSnapshot, readSnapshot, studentResult, type AttendanceCounts, type ExamSubjectInfo, type ReportCardSnapshot } from "./results.rules";

/**
 * Phase 4B-M6 — results preview, publication and report cards (PHASE_4_PLAN.md AC14, AC15, AC20).
 *
 * - Publish (`result.publish`: Principal, Vice Principal): LOCKED → PUBLISHED. Re-checks every sheet under the exam lock,
 *   then writes one ReportCard SNAPSHOT per ACTIVE enrollment of the exam's classes, in one transaction. Rank in class
 *   only when the school setting says so (AC14; ties share a rank).
 * - Read results: `exam.manage`, `result.publish`, `marks.approve`, `result.read` ALL or `reportcard.generate` ALL → any
 *   section; `result.read` / `reportcard.generate` ASSIGNED → the user's own class-teacher section in an open session.
 *   Parent / Student scopes see nothing here (AC20: no portal yet).
 * - Class-teacher remark and report-card PDF: `reportcard.generate` (ALL, or ASSIGNED for the own section).
 * - The PDF is rendered on demand from the snapshot (no stored copy and no verification code yet — KI-090).
 * Published results never change: there is no unpublish or post-publication correction in 4B (KI-091).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};
type Db = Tx | typeof prisma;
const MAX_STUDENTS = 5000;
type ScopeKey = "result.read" | "reportcard.generate";
const scopeOf = (ctx: AuthContext, key: ScopeKey) => (hasPermission(ctx, key) ? scopeFor(ctx, key) : null);

interface SectionFacts {
  classTeacherId: string | null;
  sessionStatus: string;
}

export function resultsAccess(ctx: AuthContext, section: SectionFacts) {
  const own = section.classTeacherId === ctx.userId && section.sessionStatus !== "CLOSED";
  const card = scopeOf(ctx, "reportcard.generate");
  const read = scopeOf(ctx, "result.read");
  const canCard = card === "ALL" || (card === "ASSIGNED" && own);
  const canRead =
    canCard ||
    read === "ALL" ||
    (read === "ASSIGNED" && own) ||
    hasPermission(ctx, "exam.manage") ||
    hasPermission(ctx, "result.publish") ||
    hasPermission(ctx, "marks.approve");
  return { canRead, canCard };
}

/** Anyone with a school-wide results role (sees every section). */
function readsAllResults(ctx: AuthContext) {
  return resultsAccess(ctx, { classTeacherId: null, sessionStatus: "ACTIVE" }).canRead;
}
export const canPublishResults = (ctx: AuthContext) => hasPermission(ctx, "result.publish");

/** Sections the caller may see results for, in the exam's classes. */
export async function listResultSections(ctx: AuthContext, examinationId: string) {
  const exam = await prisma.examination.findUnique({
    where: { id: examinationId },
    select: { id: true, name: true, status: true, version: true, academicSessionId: true, academicSession: { select: { name: true, status: true } }, subjects: { select: { classSubject: { select: { classId: true } } }, take: 500 } },
  });
  if (!exam) throw new NotFoundError("Exam not found.");
  const classIds = [...new Set(exam.subjects.map((s) => s.classSubject.classId))];
  const sections = await prisma.section.findMany({
    where: { academicSessionId: exam.academicSessionId, classId: { in: classIds } },
    orderBy: [{ class: { displayOrder: "asc" } }, { code: "asc" }],
    take: 300,
    select: { id: true, code: true, classTeacherId: true },
  });
  const visible = sections.filter((s) => resultsAccess(ctx, { classTeacherId: s.classTeacherId, sessionStatus: exam.academicSession.status }).canRead);
  if (visible.length === 0 && !readsAllResults(ctx)) throw new NotFoundError("Exam not found.");
  return { exam: { id: exam.id, name: exam.name, status: exam.status, version: exam.version, sessionName: exam.academicSession.name }, sections: visible.map((s) => ({ id: s.id, code: s.code })) };
}

/**
 * Exams with results to look at (marks entry or later), newest first: school-wide readers see every open session's exams;
 * class teachers (ASSIGNED) only exams covering their own sections' classes.
 */
export async function listResultExams(ctx: AuthContext) {
  const all = readsAllResults(ctx);
  const assigned = scopeOf(ctx, "result.read") === "ASSIGNED" || scopeOf(ctx, "reportcard.generate") === "ASSIGNED";
  if (!all && !assigned) return [];
  return prisma.examination.findMany({
    where: {
      status: { in: ["MARKS_ENTRY", "LOCKED", "PUBLISHED"] },
      academicSession: { status: { not: "CLOSED" } },
      ...(all
        ? {}
        : { subjects: { some: { classSubject: { class: { sections: { some: { classTeacherId: ctx.userId, academicSession: { status: { not: "CLOSED" } } } } } } } } }),
    },
    orderBy: [{ updatedAt: "desc" }],
    take: 30,
    select: { id: true, name: true, status: true, academicSession: { select: { name: true } } },
  });
}

// ───────────────────────────── Computation ─────────────────────────────

async function loadExam(db: Db, examinationId: string) {
  const exam = await db.examination.findUnique({
    where: { id: examinationId },
    select: {
      id: true,
      name: true,
      status: true,
      startDate: true,
      endDate: true,
      publishedAt: true,
      academicSessionId: true,
      academicSession: { select: { name: true, status: true } },
      gradeScale: { select: { name: true, bands: { orderBy: { minPercent: "asc" }, select: { minPercent: true, grade: true, gradePoint: true, remark: true } } } },
      subjects: {
        take: 500,
        orderBy: [{ classSubject: { sortOrder: "asc" } }, { id: "asc" }],
        select: {
          id: true,
          maxTheory: true,
          maxPractical: true,
          maxInternal: true,
          passPercent: true,
          classSubject: { select: { id: true, classId: true, isOptional: true, subject: { select: { code: true, name: true } } } },
        },
      },
    },
  });
  if (!exam) throw new NotFoundError("Exam not found.");
  const scale: GradeBand[] = exam.gradeScale.bands.map((b) => ({
    minPercent: b.minPercent.toString(),
    grade: b.grade,
    gradePoint: b.gradePoint === null ? null : b.gradePoint.toString(),
    remark: b.remark,
  }));
  return { exam, scale };
}
type LoadedExam = Awaited<ReturnType<typeof loadExam>>;

interface StudentRow {
  enrollmentId: string;
  sectionId: string;
  classId: string;
  student: ReportCardSnapshot["student"];
  subjects: ExamSubjectInfo[];
  marks: Map<string, MarkEntry>;
  result: OverallResult | null;
  attendance: ReportCardSnapshot["attendance"];
}

/** Results of every ACTIVE enrollment in the given sections (or all the exam's classes), computed from the marks. */
async function computeResults(db: Db, loaded: LoadedExam, sectionIds: string[] | null, today: string): Promise<StudentRow[]> {
  const { exam, scale } = loaded;
  const classIds = [...new Set(exam.subjects.map((s) => s.classSubject.classId))];
  const where = {
    academicSessionId: exam.academicSessionId,
    status: "ACTIVE" as const,
    student: { deletedAt: null },
    section: { classId: { in: classIds } },
    ...(sectionIds ? { sectionId: { in: sectionIds } } : {}),
  };
  // Review 4B L4: never cut the list silently — publication and class ranks need every student.
  if ((await db.studentEnrollment.count({ where })) > MAX_STUDENTS) throw new ConflictError(`This exam covers more than ${MAX_STUDENTS} students; split it into exams per class group.`);
  const enrollments = await db.studentEnrollment.findMany({
    where,
    orderBy: [{ section: { code: "asc" } }, { rollNumber: { rollNumber: "asc" } }, { student: { fullNameNormalized: "asc" } }, { id: "asc" }],
    take: MAX_STUDENTS,
    select: {
      id: true,
      sectionId: true,
      section: { select: { code: true, classId: true, class: { select: { name: true } } } },
      rollNumber: { select: { rollNumber: true } },
      student: { select: { studentCode: true, fullName: true } },
      subjects: { select: { classSubjectId: true } },
    },
  });
  if (enrollments.length === 0) return [];
  const ids = enrollments.map((e) => e.id);
  const cutoff = new Date(`${iso(exam.endDate) && iso(exam.endDate)! < today ? iso(exam.endDate) : today}T00:00:00.000Z`);
  const [marks, attendance] = await Promise.all([
    db.examinationMarks.findMany({
      where: { enrollmentId: { in: ids }, sheet: { examSubject: { examinationId: exam.id } } },
      select: { enrollmentId: true, status: true, theory: true, practical: true, internal: true, sheet: { select: { examSubjectId: true, sectionId: true } } },
    }),
    db.studentAttendance.groupBy({ by: ["enrollmentId", "status"], where: { enrollmentId: { in: ids }, date: { lte: cutoff } }, _count: { _all: true } }),
  ]);
  const marksOf = new Map<string, Map<string, MarkEntry>>();
  const sectionOf = new Map(enrollments.map((e) => [e.id, e.sectionId]));
  for (const m of marks) {
    // Only marks from the student's CURRENT section's sheet count (a moved student is re-entered in the new section).
    if (sectionOf.get(m.enrollmentId) !== m.sheet.sectionId) continue;
    const map = marksOf.get(m.enrollmentId) ?? new Map<string, MarkEntry>();
    map.set(m.sheet.examSubjectId, { status: m.status, theory: markString(m.theory), practical: markString(m.practical), internal: markString(m.internal) });
    marksOf.set(m.enrollmentId, map);
  }
  const counts = new Map<string, AttendanceCounts>();
  for (const a of attendance) {
    const c = counts.get(a.enrollmentId) ?? { present: 0, late: 0, halfDay: 0, absent: 0, excused: 0 };
    const n = a._count._all;
    if (a.status === "PRESENT") c.present += n;
    else if (a.status === "LATE") c.late += n;
    else if (a.status === "HALF_DAY") c.halfDay += n;
    else if (a.status === "ABSENT") c.absent += n;
    else c.excused += n;
    counts.set(a.enrollmentId, c);
  }
  return enrollments.map((e) => {
    const chosen = new Set(e.subjects.map((s) => s.classSubjectId));
    const subjects: ExamSubjectInfo[] = exam.subjects
      .filter((s) => s.classSubject.classId === e.section.classId && (!s.classSubject.isOptional || chosen.has(s.classSubject.id)))
      .map((s) => ({
        id: s.id,
        code: s.classSubject.subject.code,
        name: s.classSubject.subject.name,
        max: { theory: s.maxTheory, practical: s.maxPractical, internal: s.maxInternal },
        passPercent: s.passPercent === null ? null : s.passPercent.toString(),
      }));
    const m = marksOf.get(e.id) ?? new Map<string, MarkEntry>();
    return {
      enrollmentId: e.id,
      sectionId: e.sectionId,
      classId: e.section.classId,
      student: { code: e.student.studentCode, name: e.student.fullName, rollNumber: e.rollNumber?.rollNumber ?? null, className: e.section.class.name, sectionCode: e.section.code },
      subjects,
      marks: m,
      result: studentResult(scale, subjects, m),
      attendance: attendancePercent(counts.get(e.id) ?? { present: 0, late: 0, halfDay: 0, absent: 0, excused: 0 }),
    };
  });
}

// ───────────────────────────── Reads ─────────────────────────────

async function sectionFor(examSessionId: string, sectionId: string) {
  const s = await prisma.section.findUnique({ where: { id: sectionId }, select: { id: true, code: true, classTeacherId: true, academicSessionId: true, academicSession: { select: { status: true } } } });
  if (!s || s.academicSessionId !== examSessionId) throw new NotFoundError("Section not found.");
  return s;
}

/**
 * A section's results: the published report cards, or — before publication, once marks entry has started — a live
 * preview from the marks (no rank; incomplete students flagged).
 */
export async function getSectionResults(ctx: AuthContext, input: SectionResultsInput) {
  const loaded = await loadExam(prisma, input.examinationId);
  const { exam } = loaded;
  const section = await sectionFor(exam.academicSessionId, input.sectionId);
  const access = resultsAccess(ctx, { classTeacherId: section.classTeacherId, sessionStatus: section.academicSession.status });
  if (!access.canRead) throw new NotFoundError("Section not found.");
  const head = { exam: { id: exam.id, name: exam.name, status: exam.status, sessionName: exam.academicSession.name, scale: exam.gradeScale.name }, section: { id: section.id, code: section.code }, canCard: access.canCard };
  if (exam.status === "PUBLISHED") {
    const cards = await prisma.reportCard.findMany({
      where: { examinationId: exam.id, enrollment: { sectionId: section.id } },
      take: 300,
      select: { id: true, version: true, remark: true, snapshot: true },
    });
    const rows = cards
      .map((c) => ({ id: c.id, version: c.version, remark: c.remark, snapshot: readSnapshot(c.snapshot) }))
      .filter((c): c is { id: string; version: number; remark: string | null; snapshot: ReportCardSnapshot } => c.snapshot !== null)
      .sort((a, b) => (a.snapshot.student.rollNumber ?? 9999) - (b.snapshot.student.rollNumber ?? 9999) || a.snapshot.student.name.localeCompare(b.snapshot.student.name));
    return { ...head, mode: "published" as const, publishedAt: exam.publishedAt, cards: rows, preview: [] };
  }
  if (exam.status !== "MARKS_ENTRY" && exam.status !== "LOCKED") return { ...head, mode: "none" as const, publishedAt: null, cards: [], preview: [] };
  const { timezone } = await prisma.$transaction((tx) => readResultSettingsTx(tx));
  const rows = await computeResults(prisma, loaded, [section.id], todayInTimeZone(timezone ?? undefined));
  return {
    ...head,
    mode: "preview" as const,
    publishedAt: null,
    cards: [],
    preview: rows.map((r) => ({
      enrollmentId: r.enrollmentId,
      student: r.student,
      attendance: r.attendance,
      result: r.result ? { obtained: r.result.obtained, max: r.result.max, percent: r.result.percent, grade: r.result.grade, result: r.result.result, failed: r.result.failedSubjects } : null,
    })),
  };
}

// ───────────────────────────── Publish ─────────────────────────────

const CHUNK = 500;


/**
 * Phase 6C-M2 (P23): after the publication committed, one in-app notification per family (and student) account of each
 * child with a new report card — "the report card is ready", never marks or results. Dedupe `result:<student>:<exam>`.
 */
async function resultNotifications(examId: string): Promise<NotificationDraft[]> {
  const exam = await prisma.examination.findUnique({ where: { id: examId }, select: { name: true } });
  if (!exam) return [];
  const cards = await prisma.reportCard.findMany({ where: { examinationId: examId }, select: { enrollment: { select: { studentId: true } } }, take: 20_000 });
  const recipients = await familyRecipientsOf(prisma, cards.map((c) => c.enrollment.studentId), { students: true });
  return recipients.map((r) => ({
    userId: r.userId,
    type: "result.published" as const,
    title: "Report card ready",
    body: `${r.firstName}'s report card for ${exam.name} is ready.`,
    link: `/portal/c/${encodeURIComponent(r.studentId)}/results`,
    dedupeKey: `result:${r.studentId}:${examId}`,
  }));
}

/** LOCKED → PUBLISHED with one report-card snapshot per ACTIVE enrollment (`result.publish`). */
export async function publishResults(ctx: AuthContext, input: ExamRefInput) {
  if (!canPublishResults(ctx)) throw new ForbiddenError();
  let published: { reportCards: number; passed: number };
  try {
    published = await prisma.$transaction(
      async (tx) => {
        const row = await lockExamRowTx(tx, input);
        if (row.status !== "LOCKED") throw new ConflictError("Lock the exam's marks before publishing results.");
        const problems = lockProblems(requiredSheets(await sheetCoverage(tx, input.id, row.academicSessionId)));
        if (problems.length > 0) throw new ConflictError(`Marks changed after locking: ${problems.join(" ")} Reopen marks entry to fix them.`);
        const loaded = await loadExam(tx, input.id);
        await tx.$queryRaw`SELECT id FROM grade_scale WHERE id = (SELECT grade_scale_id FROM examination WHERE id = ${input.id}) FOR SHARE`;
        const settings = await readResultSettingsTx(tx);
        const today = todayInTimeZone(settings.timezone ?? undefined);
        const rows = await computeResults(tx, loaded, null, today);
        if (rows.length === 0) throw new ConflictError("No students are enrolled in this exam's classes.");
        const missing = rows.filter((r) => r.result === null);
        if (missing.length > 0) throw new ConflictError(`Results can't be worked out for ${missing.length} student(s) (e.g. ${missing[0].student.name}, ${missing[0].student.sectionCode}). Reopen marks entry to fix their marks.`);
        const ranks = new Map<string, number>();
        if (settings.showRank) {
          for (const classId of new Set(rows.map((r) => r.classId))) {
            const ranked = rankByPercent(rows.filter((r) => r.classId === classId).map((r) => ({ id: r.enrollmentId, percentExact: r.result!.percentExact })));
            for (const [k, v] of ranked) ranks.set(k, v);
          }
        }
        const { exam } = loaded;
        const examInfo = { name: exam.name, session: exam.academicSession.name, startDate: iso(exam.startDate), endDate: iso(exam.endDate) };
        const now = new Date();
        const data = rows.map((r) => ({
          academicSessionId: exam.academicSessionId,
          examinationId: exam.id,
          enrollmentId: r.enrollmentId,
          publishedAt: now,
          snapshot: buildSnapshot({
            exam: examInfo,
            student: r.student,
            scale: exam.gradeScale.name,
            subjects: r.subjects,
            marks: r.marks,
            result: r.result!,
            rank: ranks.get(r.enrollmentId) ?? null,
            attendance: r.attendance,
          }) as unknown as Prisma.InputJsonValue,
        }));
        for (let i = 0; i < data.length; i += CHUNK) await tx.reportCard.createMany({ data: data.slice(i, i + CHUNK) });
        await tx.examination.update({ where: { id: exam.id }, data: { status: "PUBLISHED", publishedAt: now, publishedById: ctx.userId, version: { increment: 1 } } });
        const passed = rows.filter((r) => r.result!.result === "PASS").length;
        await audit(tx, actorOf(ctx), {
          action: "examination.publish",
          entityType: "Examination",
          entityId: exam.id,
          before: { status: "LOCKED" },
          after: { status: "PUBLISHED", reportCards: rows.length, passed, showRank: settings.showRank },
        });
        return { reportCards: rows.length, passed };
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    return busy(e);
  }
  await afterCommit("results", () => resultNotifications(input.id));
  return published;
}

// ───────────────────────────── Report cards ─────────────────────────────

async function cardWithAccess(ctx: AuthContext, id: string) {
  const card = await prisma.reportCard.findUnique({
    where: { id },
    select: {
      id: true,
      version: true,
      remark: true,
      snapshot: true,
      publishedAt: true,
      enrollment: { select: { section: { select: { classTeacherId: true, academicSession: { select: { status: true } } } } } },
    },
  });
  if (!card) throw new NotFoundError("Report card not found.");
  const access = resultsAccess(ctx, { classTeacherId: card.enrollment.section.classTeacherId, sessionStatus: card.enrollment.section.academicSession.status });
  if (!access.canCard) throw new NotFoundError("Report card not found.");
  return card;
}

/** The class teacher's remark (AC15). Printed on the report card; not part of the frozen snapshot. */
export async function setReportCardRemark(ctx: AuthContext, input: ReportCardRemarkInput) {
  if (!hasPermission(ctx, "reportcard.generate")) throw new ForbiddenError();
  await cardWithAccess(ctx, input.id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      const [row] = await tx.$queryRaw<{ version: number; remark: string | null }[]>`SELECT version, remark FROM report_card WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new NotFoundError("Report card not found.");
      if (row.version !== input.version) throw new ConflictError("This report card was changed by someone else. Reload the page and try again.");
      if (row.remark === input.remark) return;
      await tx.reportCard.update({ where: { id: input.id }, data: { remark: input.remark, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "report_card.remark", entityType: "ReportCard", entityId: input.id, after: { hasRemark: input.remark !== null } });
    });
  } catch (e) {
    busy(e);
  }
}

export async function renderReportCardPdf(ctx: AuthContext, id: string): Promise<{ pdf: Buffer; fileName: string }> {
  if (!hasPermission(ctx, "reportcard.generate")) throw new NotFoundError("Report card not found.");
  const card = await cardWithAccess(ctx, id);
  const snapshot = readSnapshot(card.snapshot);
  if (!snapshot) throw new ConflictError("This report card can't be printed (unknown format).");
  const branding = await loadBranding();
  const pdf = await renderPdf(createElement(ReportCardDocument, { branding, snapshot, remark: card.remark, publishedAt: card.publishedAt, generatedAt: new Date() }));
  const safe = (s: string) => s.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "exam";
  return { pdf, fileName: `report-card-${safe(snapshot.exam.name)}-${safe(snapshot.student.code)}.pdf` };
}
