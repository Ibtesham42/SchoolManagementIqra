import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { renderPdf } from "@/lib/pdf/render";
import { validateScale } from "@/modules/academic/grade-calc";
import { dateProblem, manualTransitions, scaleEditable, subjectsEditable, transitionProblem } from "@/modules/academic/examinations.rules";
import { addExamSubjectsSchema, createExamSchema } from "@/modules/academic/examinations.schemas";
import { addExamSubjects, createExam, deleteExam, examAccess, setExamStatus } from "@/modules/academic/examinations.service";
import { approverCanCorrect, entryProblem, lockProblems, sameEntry, sheetActionProblem, teacherCanEdit, type MarkEntry } from "@/modules/academic/marks.rules";
import { reportCardRemarkSchema, saveMarksSchema } from "@/modules/academic/marks.schemas";
import { canApproveMarks, examMarksAccess, listMyMarksSheets, lockExamMarks, saveMarks, sheetAction, unlockExamMarks } from "@/modules/academic/marks.service";
import { attendancePercent, buildSnapshot, readSnapshot, studentResult, type ExamSubjectInfo } from "@/modules/academic/results.rules";
import { canPublishResults, publishResults, renderReportCardPdf, resultsAccess, setReportCardRemark } from "@/modules/academic/results.service";
import { buildBranding } from "@/modules/documents/branding";
import { ReportCardDocument } from "@/modules/documents/templates/report-card";
import { FALLBACK_PROFILE } from "@/modules/settings/settings.public";
import { extractTextRuns, nonWinAnsiChars, pageText } from "../pdf-text";

/** Phase 4B-M3…M6: exam lifecycle, marks rules, maker-checker, lock readiness, results, report-card PDF and role gates. */
function roleCtx(roleKey: string, extra: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows), ...extra };
}
const ALL_ROLES = ROLES.map((r) => r.key);
const max = { theory: 80, practical: 0, internal: 20 };
const e = (status: MarkEntry["status"], theory: string | null, internal: string | null, practical: string | null = null): MarkEntry => ({ status, theory, practical, internal });

describe("exam lifecycle rules", () => {
  it("allows only the manual steps; scheduling needs subjects; marks entry can't step back once marks exist", () => {
    expect(manualTransitions("DRAFT")).toEqual(["SCHEDULED"]);
    expect(manualTransitions("LOCKED")).toEqual([]);
    expect(manualTransitions("PUBLISHED")).toEqual([]);
    expect(transitionProblem("DRAFT", "SCHEDULED", { subjectCount: 0, marksCount: 0 })).toMatch(/at least one subject/);
    expect(transitionProblem("DRAFT", "SCHEDULED", { subjectCount: 2, marksCount: 0 })).toBeNull();
    expect(transitionProblem("MARKS_ENTRY", "SCHEDULED", { subjectCount: 2, marksCount: 1 })).toMatch(/already been entered/);
    expect(transitionProblem("DRAFT", "MARKS_ENTRY", { subjectCount: 2, marksCount: 0 })).toMatch(/can't move/);
    expect(subjectsEditable("SCHEDULED")).toBe(true);
    expect(subjectsEditable("MARKS_ENTRY")).toBe(false);
    expect(scaleEditable("SCHEDULED")).toBe(false);
    expect(dateProblem("2026-08-31", "2026-09-01", "2026-09-15")).toMatch(/before/);
    expect(dateProblem("2026-09-16", "2026-09-01", "2026-09-15")).toMatch(/after/);
    expect(dateProblem(null, "2026-09-01", null)).toBeNull();
  });
  it("schemas: dates in order, at least one examined part, strict keys", () => {
    expect(createExamSchema.safeParse({ academicSessionId: "s", name: "Term", gradeScaleId: "g", startDate: "2026-09-10", endDate: "2026-09-01" }).success).toBe(false);
    expect(createExamSchema.safeParse({ academicSessionId: "s", name: "Term", gradeScaleId: "g", startDate: "", endDate: "", extra: 1 }).success).toBe(false);
    const base = { examinationId: "e", version: "1", classSubjectIds: ["c"], examDate: "", passPercent: "" };
    expect(addExamSubjectsSchema.safeParse({ ...base, maxTheory: "", maxPractical: "", maxInternal: "" }).success).toBe(false);
    expect(addExamSubjectsSchema.parse({ ...base, maxTheory: "80", maxPractical: "", maxInternal: "20" })).toMatchObject({ maxTheory: 80, maxPractical: 0, maxInternal: 20, passPercent: null, examDate: null });
    expect(addExamSubjectsSchema.safeParse({ ...base, maxTheory: "80.5", maxPractical: "", maxInternal: "" }).success).toBe(false);
  });
});

describe("marks entry rules (AC10)", () => {
  it("whole or half marks within each part's maximum; unexamined parts stay blank; AB / EX carry no marks", () => {
    expect(entryProblem(e("PRESENT", "79.5", "20"), max, false)).toBeNull();
    expect(entryProblem(e("PRESENT", "80.5", "20"), max, false)).toMatch(/more than the maximum 80/);
    expect(entryProblem(e("PRESENT", "40.25", "20"), max, false)).toMatch(/whole or half/);
    expect(entryProblem(e("PRESENT", "40", "10", "5"), max, false)).toMatch(/Practical isn't examined/);
    expect(entryProblem(e("PRESENT", "40", null), max, false)).toMatch(/Internal marks are missing/);
    expect(entryProblem(e("PRESENT", "40", null), max, true)).toBeNull(); // partial save while open
    expect(entryProblem(e("ABSENT", null, null), max, false)).toBeNull();
    expect(entryProblem(e("EXEMPT", "10", null), max, false)).toMatch(/blank for EX/);
    expect(sameEntry(e("PRESENT", "42", "10"), e("PRESENT", "42.0", "10"))).toBe(true);
    expect(sameEntry(e("PRESENT", "42", "10"), e("ABSENT", null, null))).toBe(false);
  });
  it("who may edit: the teacher while open in marks entry; approvers correct approved sheets until publication", () => {
    expect(teacherCanEdit({ examStatus: "MARKS_ENTRY", sheetStatus: null })).toBe(true);
    expect(teacherCanEdit({ examStatus: "MARKS_ENTRY", sheetStatus: "SUBMITTED" })).toBe(false);
    expect(teacherCanEdit({ examStatus: "LOCKED", sheetStatus: "OPEN" })).toBe(false);
    expect(approverCanCorrect({ examStatus: "LOCKED", sheetStatus: "APPROVED" })).toBe(true);
    expect(approverCanCorrect({ examStatus: "PUBLISHED", sheetStatus: "APPROVED" })).toBe(false);
    expect(approverCanCorrect({ examStatus: "MARKS_ENTRY", sheetStatus: "SUBMITTED" })).toBe(false);
  });
  it("submit needs everyone's marks; approval is maker-checker (AC13)", () => {
    const f = { examStatus: "MARKS_ENTRY" as const, rosterCount: 3, completeCount: 3, actorSubmitted: false, actorEntered: false };
    expect(sheetActionProblem("submit", { ...f, sheetStatus: "OPEN", completeCount: 2 })).toMatch(/missing for 1/);
    expect(sheetActionProblem("submit", { ...f, sheetStatus: "OPEN" })).toBeNull();
    expect(sheetActionProblem("approve", { ...f, sheetStatus: "OPEN" })).toMatch(/Only a submitted/);
    expect(sheetActionProblem("approve", { ...f, sheetStatus: "SUBMITTED", actorSubmitted: true })).toMatch(/someone else/);
    expect(sheetActionProblem("approve", { ...f, sheetStatus: "SUBMITTED", actorEntered: true })).toMatch(/someone else/);
    expect(sheetActionProblem("approve", { ...f, sheetStatus: "SUBMITTED" })).toBeNull();
    expect(sheetActionProblem("return", { ...f, sheetStatus: "SUBMITTED", actorSubmitted: true })).toBeNull();
    expect(sheetActionProblem("submit", { ...f, sheetStatus: "OPEN", examStatus: "LOCKED" })).toMatch(/isn't open/);
  });
  it("lock readiness lists unstarted, unapproved and incomplete sheets (max 5); empty sections don't count", () => {
    expect(lockProblems([{ label: "A Maths", rosterCount: 30, sheet: { status: "APPROVED", markCount: 30 } }, { label: "B Maths", rosterCount: 0, sheet: null }])).toEqual([]);
    const p = lockProblems([
      { label: "A Maths", rosterCount: 30, sheet: null },
      { label: "A Art", rosterCount: 30, sheet: { status: "SUBMITTED", markCount: 30 } },
      { label: "A Hindi", rosterCount: 31, sheet: { status: "APPROVED", markCount: 30 } },
    ]);
    expect(p).toEqual(["A Maths: no marks entered.", "A Art: submitted, not approved.", "A Hindi: marks missing for 1 student(s)."]);
  });
  it("save schema: blank marks become null; duplicates, bad marks and short reasons are refused", () => {
    const row = { enrollmentId: "e1", status: "PRESENT", theory: "42.5", practical: "", internal: " 10 ", version: null };
    const ok = saveMarksSchema.parse({ examSubjectId: "x", sectionId: "s", sheetVersion: null, reason: "", entries: [row] });
    expect(ok.entries[0]).toMatchObject({ theory: "42.5", practical: null, internal: "10" });
    expect(saveMarksSchema.safeParse({ examSubjectId: "x", sectionId: "s", sheetVersion: null, reason: "", entries: [row, row] }).success).toBe(false);
    expect(saveMarksSchema.safeParse({ examSubjectId: "x", sectionId: "s", sheetVersion: null, reason: "", entries: [{ ...row, theory: "4.2" }] }).success).toBe(false);
    expect(saveMarksSchema.safeParse({ examSubjectId: "x", sectionId: "s", sheetVersion: null, reason: "ok", entries: [row] }).success).toBe(false);
    expect(reportCardRemarkSchema.parse({ id: "r", version: "1", remark: "   " }).remark).toBeNull();
  });
});

describe("results and snapshots (AC9, AC10, AC15, AC21)", () => {
  const scale = validateScale([
    { minPercent: "0", grade: "C", gradePoint: null, remark: null },
    { minPercent: "50", grade: "B", gradePoint: null, remark: null },
    { minPercent: "80", grade: "A", gradePoint: null, remark: null },
  ]);
  const subjects: ExamSubjectInfo[] = [
    { id: "m", code: "MAT", name: "Maths", max, passPercent: "33" },
    { id: "a", code: "ART", name: "Art", max: { theory: 0, practical: 50, internal: 0 }, passPercent: null },
  ];
  it("AB counts 0 (and fails the pass mark); EX leaves the subject out; missing marks → no result", () => {
    const r = studentResult(scale, subjects, new Map([["m", e("PRESENT", "70", "18")], ["a", e("PRESENT", null, null, "45.5")]]))!;
    expect(r).toMatchObject({ obtained: "133.5", max: 150, percent: "89.00", grade: "A", result: "PASS" });
    const ab = studentResult(scale, subjects, new Map([["m", e("ABSENT", null, null)], ["a", e("PRESENT", null, null, "40")]]))!;
    expect(ab).toMatchObject({ obtained: "40", max: 150, result: "FAIL", failedSubjects: ["MAT"] });
    const ex = studentResult(scale, subjects, new Map([["m", e("PRESENT", "40", "10")], ["a", e("EXEMPT", null, null)]]))!;
    expect(ex).toMatchObject({ obtained: "50", max: 100, grade: "B" });
    expect(studentResult(scale, subjects, new Map([["m", e("PRESENT", "40", null)]]))).toBeNull();
  });
  it("attendance % counts late as present, half day as half, excused as not attended", () => {
    expect(attendancePercent({ present: 7, late: 1, halfDay: 1, absent: 0, excused: 1 })).toEqual({ marked: 10, percent: "85.00" });
    expect(attendancePercent({ present: 0, late: 0, halfDay: 0, absent: 0, excused: 0 })).toEqual({ marked: 0, percent: null });
  });
  it("the snapshot round-trips and renders a WinAnsi-only report card PDF", async () => {
    const marks = new Map([["m", e("PRESENT", "70", "18")], ["a", e("PRESENT", null, null, "45.5")]]);
    const snap = buildSnapshot({
      exam: { name: "Term 1", session: "2026-27", startDate: "2026-09-01", endDate: "2026-09-15" },
      student: { code: "STU-2026-0001", name: "Synthetic Pupil", rollNumber: 4, className: "Class 8", sectionCode: "C8-A" },
      scale: "Demo scale",
      subjects,
      marks,
      result: studentResult(scale, subjects, marks)!,
      rank: 2,
      attendance: { marked: 10, percent: "85.00" },
    });
    const back = readSnapshot(JSON.parse(JSON.stringify(snap)))!;
    expect(back.total.grade).toBe("A");
    expect(readSnapshot({ v: 2 })).toBeNull();
    const pdf = await renderPdf(createElement(ReportCardDocument, { branding: buildBranding(FALLBACK_PROFILE), snapshot: back, remark: "Steady progress.", publishedAt: new Date("2026-10-01T00:00:00Z"), generatedAt: new Date() }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pageText(extractTextRuns(pdf), 1);
    for (const s of ["Synthetic Pupil", "STU-2026-0001", "133.5 / 150", "89.00 %", "Rank in class", "Steady progress.", "45.5/50", "85.00 %"]) expect(text).toContain(s);
    expect(nonWinAnsiChars(text)).toEqual([]);
  }, 30_000);
});

describe("examination, marks and results role gates (every role)", () => {
  const managers = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL"]);
  const approvers = new Set(["SUPER_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL"]);
  it("exam setup: only exam.manage holders; others refused before any database access", async () => {
    const input = createExamSchema.parse({ academicSessionId: "s", name: "T", gradeScaleId: "g", startDate: "", endDate: "" });
    for (const key of ALL_ROLES) {
      const ctx = roleCtx(key);
      expect(examAccess(ctx).manage, key).toBe(managers.has(key));
      if (managers.has(key)) continue;
      await expect(createExam(ctx, input), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setExamStatus(ctx, { id: "x", version: 1, to: "SCHEDULED" }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteExam(ctx, { id: "x", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addExamSubjects(ctx, { examinationId: "x", version: 1, classSubjectIds: ["c"], examDate: null, maxTheory: 10, maxPractical: 0, maxInternal: 0, passPercent: null }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const key of ["PARENT", "STUDENT", "TEACHER", "CLASS_TEACHER"]) expect(examAccess(roleCtx(key)).read, key).toBe(false);
  });
  it("approve / lock / unlock: only marks.approve; publish: only result.publish", async () => {
    for (const key of ALL_ROLES) {
      const ctx = roleCtx(key);
      expect(canApproveMarks(ctx), key).toBe(approvers.has(key));
      expect(examMarksAccess(ctx).lock, key).toBe(approvers.has(key));
      expect(canPublishResults(ctx), key).toBe(approvers.has(key));
      if (approvers.has(key)) continue;
      await expect(lockExamMarks(ctx, { id: "x", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(unlockExamMarks(ctx, { id: "x", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(publishResults(ctx, { id: "x", version: 1 }), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("marks writes and the marks list: roles without marks.enter / marks.approve are refused", async () => {
    const save = { examSubjectId: "x", sectionId: "s", sheetVersion: null, reason: "", entries: [{ enrollmentId: "e", status: "PRESENT" as const, theory: "1", practical: null, internal: null, version: null }] };
    for (const key of ["ACCOUNTANT", "LIBRARIAN", "TRANSPORT_MANAGER", "PARENT", "STUDENT", "SCHOOL_ADMIN"]) {
      if (!ROLES.some((r) => r.key === key)) continue;
      const ctx = roleCtx(key);
      await expect(saveMarks(ctx, save), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(sheetAction(ctx, { examSubjectId: "x", sectionId: "s", sheetVersion: 1, action: "submit" }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listMyMarksSheets(ctx), key).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("results: parents and students see nothing (AC20); class teachers only their own open section; remarks / PDF need reportcard.generate", async () => {
    const own = { classTeacherId: "u", sessionStatus: "ACTIVE" };
    const other = { classTeacherId: "someone", sessionStatus: "ACTIVE" };
    for (const key of ["PARENT", "STUDENT"]) expect(resultsAccess(roleCtx(key), own), key).toEqual({ canRead: false, canCard: false });
    expect(resultsAccess(roleCtx("CLASS_TEACHER"), own)).toEqual({ canRead: true, canCard: true });
    expect(resultsAccess(roleCtx("CLASS_TEACHER"), other)).toEqual({ canRead: false, canCard: false });
    expect(resultsAccess(roleCtx("CLASS_TEACHER"), { ...own, sessionStatus: "CLOSED" })).toEqual({ canRead: false, canCard: false });
    expect(resultsAccess(roleCtx("TEACHER"), own)).toEqual({ canRead: true, canCard: false });
    expect(resultsAccess(roleCtx("SCHOOL_ADMIN"), other)).toEqual({ canRead: true, canCard: true });
    expect(resultsAccess(roleCtx("VICE_PRINCIPAL"), other)).toEqual({ canRead: true, canCard: false });
    for (const key of ["TEACHER", "PARENT", "STUDENT", "ACCOUNTANT"]) {
      await expect(setReportCardRemark(roleCtx(key), { id: "r", version: 1, remark: null }), key).rejects.toBeInstanceOf(ForbiddenError);
      await expect(renderReportCardPdf(roleCtx(key), "r"), key).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
