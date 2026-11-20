import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 4B (M3–M6) examinations end to end against real Postgres (Neon Test branch only, behind the S-05 target guard;
 * skipped without TEST_DATABASE_URL). One simulated term: grading scale → exam → subjects → schedule → marks entry by
 * the allocated teacher only → submit → maker-checker approval → lock → publish → report-card snapshot, remark and PDF.
 * Synthetic data in a far-future session; removed in afterAll except audit rows (append-only, S-07).
 * Needs migration 20261122000000 applied to the Test branch.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/academic/grading.service")),
  ...(await import("@/modules/academic/examinations.service")),
  ...(await import("@/modules/academic/marks.service")),
  ...(await import("@/modules/academic/marks-import.service")),
  ...(await import("@/modules/academic/results.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("examinations, marks and results (integration)", () => {
  const run = `ex${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, principal: Ctx, vp: Ctx, teacher: Ctx, otherTeacher: Ctx, classTeacher: Ctx;
  let sessionId: string, sectionId: string, csMath: string, csArt: string, scaleId: string, examId: string;
  const enr: string[] = [];

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;
  const exam = () => m.getExam(admin, examId);

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    admin = await login((await user("admin", "SCHOOL_ADMIN")).id);
    principal = await login((await user("prin", "PRINCIPAL")).id);
    vp = await login((await user("vp", "VICE_PRINCIPAL")).id);
    const t = await user("t1", "TEACHER");
    const t1 = await linkTeachingEmployee(m.prisma, tag, t.id);
    teacher = await login(t.id);
    const o = await user("t2", "TEACHER");
    await linkTeachingEmployee(m.prisma, tag, o.id);
    otherTeacher = await login(o.id);
    const ct = await user("ct", "CLASS_TEACHER");
    await linkTeachingEmployee(m.prisma, tag, ct.id);
    classTeacher = await login(ct.id);

    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}C8`, name: `${run} eight`, nameKey: `${run} eight`, numericLevel: 8 } })).id;
    sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name: "A", nameKey: "a", code: `${tag}C8-A`, capacity: 40, classTeacherId: ct.id } })).id;
    const subj = async (code: string) => (await m.prisma.subject.create({ data: { code: `${tag}${code}`, name: `${run} ${code}`, nameKey: `${run} ${code}`.toLowerCase() } })).id;
    csMath = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("MAT") } })).id;
    csArt = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("ART"), isOptional: true } })).id;
    await m.prisma.teacherAllocation.create({ data: { academicSessionId: sessionId, sectionId, classSubjectId: csMath, employeeId: t1 } });
    await m.prisma.teacherAllocation.create({ data: { academicSessionId: sessionId, sectionId, classSubjectId: csArt, employeeId: t1 } });
    for (let i = 1; i <= 3; i++) {
      const s = await m.prisma.student.create({
        data: {
          studentCode: `${tag}-STU-${i}`, admissionNo: `${tag}-ADM-${i}`, firstName: "Synthetic", fullName: `Synthetic Pupil ${i}`, fullNameNormalized: `synthetic pupil ${i}`,
          dob: d("2090-06-01"), gender: "OTHER", admissionDate: d(`${Y}-04-01`), admittedSessionId: sessionId,
        },
      });
      enr.push((await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId, enrolledOn: d(`${Y}-04-01`) } })).id);
    }
    // Only pupil 1 takes the optional subject.
    await m.prisma.studentSubject.create({ data: { academicSessionId: sessionId, enrollmentId: enr[0], classSubjectId: csArt } });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.reportCard.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.examinationMarks.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.marksSheet.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.examSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.examination.deleteMany({ where: { academicSessionId: sessionId } });
    if (scaleId) {
      await prisma.gradeBand.deleteMany({ where: { scaleId } });
      await prisma.gradeScale.deleteMany({ where: { id: scaleId } });
    }
    await prisma.studentSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.teacherAllocation.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("sets up a scale and an exam; subjects; scheduling freezes the scale's bands", async () => {
    scaleId = (await m.createScale(admin, { name: `${run} scale`, bands: [{ minPercent: "0", grade: "C", gradePoint: null, remark: null }, { minPercent: "50", grade: "B", gradePoint: null, remark: null }, { minPercent: "80", grade: "A", gradePoint: null, remark: null }] })).id;
    examId = (await m.createExam(admin, { academicSessionId: sessionId, name: `${run} Term 1`, gradeScaleId: scaleId, startDate: `${Y}-09-01`, endDate: `${Y}-09-15` })).id;
    await expect(m.createExam(admin, { academicSessionId: sessionId, name: `${run} term 1`, gradeScaleId: scaleId, startDate: null, endDate: null })).rejects.toThrow(/already exists/);
    let e = await exam();
    await expect(m.setExamStatus(admin, { id: examId, version: e.version, to: "SCHEDULED" })).rejects.toThrow(/at least one subject/);
    await expect(m.addExamSubjects(admin, { examinationId: examId, version: e.version, classSubjectIds: [csMath], examDate: `${Y}-10-01`, maxTheory: 80, maxPractical: 0, maxInternal: 20, passPercent: null })).rejects.toBeInstanceOf(m.ValidationError);
    await m.addExamSubjects(admin, { examinationId: examId, version: e.version, classSubjectIds: [csMath], examDate: `${Y}-09-02`, maxTheory: 80, maxPractical: 0, maxInternal: 20, passPercent: "33" });
    e = await exam();
    await m.addExamSubjects(admin, { examinationId: examId, version: e.version, classSubjectIds: [csArt], examDate: null, maxTheory: 0, maxPractical: 50, maxInternal: 0, passPercent: null });
    e = await exam();
    await m.setExamStatus(principal, { id: examId, version: e.version, to: "SCHEDULED" });
    const s = (await m.listScales(admin)).find((x) => x.id === scaleId)!;
    await expect(m.updateScale(admin, { id: scaleId, version: s.version, name: s.name, bands: [{ minPercent: "0", grade: "C", gradePoint: null, remark: null }, { minPercent: "40", grade: "B", gradePoint: null, remark: null }] })).rejects.toThrow(/bands are fixed/);
    e = await exam();
    await expect(m.setExamStatus(teacher, { id: examId, version: e.version, to: "MARKS_ENTRY" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.setExamStatus(admin, { id: examId, version: e.version, to: "MARKS_ENTRY" });
    expect((await exam()).status).toBe("MARKS_ENTRY");
  });

  it("only the allocated teacher enters marks; maxima and AB / EX rules are enforced; optional subjects list only choosers", async () => {
    const e = await exam();
    const math = e.subjects.find((s) => s.classSubject.id === csMath)!.id;
    const art = e.subjects.find((s) => s.classSubject.id === csArt)!.id;
    const ref = { examSubjectId: math, sectionId };
    await expect(m.getMarksSheet(otherTeacher, ref)).rejects.toBeInstanceOf(m.NotFoundError);
    const entry = (enrollmentId: string, theory: string | null, internal: string | null, status: "PRESENT" | "ABSENT" | "EXEMPT" = "PRESENT") => ({ enrollmentId, status, theory, practical: null, internal, version: null });
    await expect(m.saveMarks(otherTeacher, { ...ref, sheetVersion: null, reason: "", entries: [entry(enr[0], "50", "10")] })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.saveMarks(teacher, { ...ref, sheetVersion: null, reason: "", entries: [entry(enr[0], "81", "10")] })).rejects.toThrow(/more than the maximum/);
    await expect(m.saveMarks(teacher, { ...ref, sheetVersion: null, reason: "", entries: [entry(enr[0], "50", "10", "ABSENT")] })).rejects.toThrow(/leave marks blank/);
    // Partial save is fine while open; submission needs everyone.
    expect(await m.saveMarks(teacher, { ...ref, sheetVersion: null, reason: "", entries: [entry(enr[0], "70", "18"), entry(enr[1], "30", null)] })).toEqual({ created: 2, changed: 0 });
    let sheet = await m.getMarksSheet(teacher, ref);
    expect(sheet.completeCount).toBe(1);
    expect(sheet.canSubmit).toBe(false);
    const v = (i: number) => sheet.rows.find((r) => r.enrollmentId === enr[i])!.mark?.version ?? null;
    await m.saveMarks(teacher, {
      ...ref,
      sheetVersion: sheet.sheet!.version,
      reason: "",
      entries: [{ ...entry(enr[1], "30", "5"), version: v(1) }, entry(enr[2], null, null, "ABSENT")],
    });
    sheet = await m.getMarksSheet(teacher, ref);
    expect(sheet.completeCount).toBe(3);
    await expect(m.saveMarks(teacher, { ...ref, sheetVersion: 1, reason: "", entries: [entry(enr[0], "71", "18")] })).rejects.toThrow(/changed by someone else/);
    // 4C-M4 marks import: template → preview (writes nothing) → confirm through saveMarks; out of scope → NotFound.
    const tpl = await m.marksImportTemplate(teacher, ref, "csv");
    const csv = new TextDecoder().decode(tpl.body);
    expect(csv).toContain(`${tag}-STU-1,,Synthetic Pupil 1,70,18\r\n`);
    await expect(m.marksImportTemplate(otherTeacher, ref, "csv")).rejects.toBeInstanceOf(m.NotFoundError);
    const file = (text: string) => ({ bytes: new TextEncoder().encode(text), fileName: "marks.csv" });
    const upload = `Student ID,Name,Theory,Internal
${tag}-STU-1,x,72,
${tag}-STU-2,x,30,5
`;
    await expect(m.previewMarksImport(otherTeacher, ref, file(upload))).rejects.toBeInstanceOf(m.NotFoundError);
    const pv = await m.previewMarksImport(teacher, ref, file(upload));
    expect(pv.canConfirm).toBe(true);
    expect(pv.plan.counts).toMatchObject({ changed: 1, same: 1, problems: 0, notInFile: 1 });
    expect(pv.plan.entries).toEqual([expect.objectContaining({ enrollmentId: enr[0], theory: "72", internal: "18" })]);
    expect((await m.getMarksSheet(teacher, ref)).sheet!.version).toBe(sheet.sheet!.version); // preview wrote nothing
    expect(await m.saveMarks(teacher, { ...ref, sheetVersion: pv.sheetVersion, reason: "", entries: pv.plan.entries, source: "import" })).toEqual({ created: 0, changed: 1 });
    // Replaying the same confirmation is refused (versions moved on).
    await expect(m.saveMarks(teacher, { ...ref, sheetVersion: pv.sheetVersion, reason: "", entries: pv.plan.entries, source: "import" })).rejects.toThrow(/changed by someone else/);
    const bad = await m.previewMarksImport(teacher, ref, file(`Student ID,Theory,Internal
${tag}-STU-1,99,1
`));
    expect(bad.canConfirm).toBe(false);
    const imported = await m.prisma.auditLog.findFirst({ where: { action: "marks.save", actorId: teacher.userId }, orderBy: { at: "desc" }, select: { after: true } });
    expect(imported?.after).toMatchObject({ source: "import", changed: 1 });
    sheet = await m.getMarksSheet(teacher, ref);
    await m.sheetAction(teacher, { ...ref, sheetVersion: sheet.sheet!.version, action: "submit" });
    sheet = await m.getMarksSheet(teacher, ref);
    expect(sheet.sheet!.status).toBe("SUBMITTED");
    expect(sheet.canEdit).toBe(false);
    // Optional subject: only pupil 1 on the roster.
    const artSheet = await m.getMarksSheet(teacher, { examSubjectId: art, sectionId });
    expect(artSheet.rows.map((r) => r.enrollmentId)).toEqual([enr[0]]);
    await m.saveMarks(teacher, { examSubjectId: art, sectionId, sheetVersion: null, reason: "", entries: [{ enrollmentId: enr[0], status: "PRESENT", theory: null, practical: "45.5", internal: null, version: null }] });
    const a2 = await m.getMarksSheet(teacher, { examSubjectId: art, sectionId });
    await m.sheetAction(teacher, { examSubjectId: art, sectionId, sheetVersion: a2.sheet!.version, action: "submit" });
    // No marks or reasons in audit rows.
    const rows = await m.prisma.auditLog.findMany({ where: { action: { startsWith: "marks" }, actorId: teacher.userId }, select: { after: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/"70"|"72"|45\.5/);
  });

  it("a section of another class is not found; parents and students see no sheets or results (AC20)", async () => {
    const e = await exam();
    const math = e.subjects.find((s) => s.classSubject.id === csMath)!.id;
    const cls9 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C9`, name: `${run} nine`, nameKey: `${run} nine`, numericLevel: 9 } })).id;
    const other = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls9, name: "A", nameKey: "a", code: `${tag}C9-A`, capacity: 40 } })).id;
    await expect(m.getMarksSheet(principal, { examSubjectId: math, sectionId: other })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.saveMarks(teacher, { examSubjectId: math, sectionId: other, sheetVersion: null, reason: "", entries: [{ enrollmentId: enr[0], status: "ABSENT", theory: null, practical: null, internal: null, version: null }] })).rejects.toBeInstanceOf(m.NotFoundError);
    for (const key of ["PARENT", "STUDENT"]) {
      const ctx = await login((await user(key.toLowerCase(), key)).id);
      await expect(m.getMarksSheet(ctx, { examSubjectId: math, sectionId }), key).rejects.toBeInstanceOf(m.NotFoundError);
      await expect(m.getSectionResults(ctx, { examinationId: examId, sectionId }), key).rejects.toBeInstanceOf(m.NotFoundError);
    }
  });

  it("maker-checker approval; lock needs every sheet approved; approver corrections need a reason", async () => {
    const e = await exam();
    const math = e.subjects.find((s) => s.classSubject.id === csMath)!.id;
    const art = e.subjects.find((s) => s.classSubject.id === csArt)!.id;
    const ref = { examSubjectId: math, sectionId };
    let sheet = await m.getMarksSheet(principal, ref);
    await expect(m.sheetAction(teacher, { ...ref, sheetVersion: sheet.sheet!.version, action: "approve" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.sheetAction(principal, { ...ref, sheetVersion: sheet.sheet!.version, action: "return" });
    sheet = await m.getMarksSheet(teacher, ref);
    expect(sheet.sheet!.status).toBe("OPEN");
    await m.sheetAction(teacher, { ...ref, sheetVersion: sheet.sheet!.version, action: "submit" });
    sheet = await m.getMarksSheet(principal, ref);
    await m.sheetAction(principal, { ...ref, sheetVersion: sheet.sheet!.version, action: "approve" });
    const ex = await exam();
    await expect(m.lockExamMarks(vp, { id: examId, version: ex.version })).rejects.toThrow(/submitted, not approved/);
    const a = await m.getMarksSheet(vp, { examSubjectId: art, sectionId });
    await m.sheetAction(vp, { examSubjectId: art, sectionId, sheetVersion: a.sheet!.version, action: "approve" });
    // Correction by an approver after approval: reason required; stays approved.
    sheet = await m.getMarksSheet(principal, ref);
    expect(sheet.canCorrect).toBe(true);
    const row = sheet.rows.find((r) => r.enrollmentId === enr[1])!;
    const fix = { enrollmentId: enr[1], status: "PRESENT" as const, theory: "32", practical: null, internal: "5", version: row.mark!.version };
    await expect(m.saveMarks(principal, { ...ref, sheetVersion: sheet.sheet!.version, reason: "", entries: [fix] })).rejects.toBeInstanceOf(m.ValidationError);
    await m.saveMarks(principal, { ...ref, sheetVersion: sheet.sheet!.version, reason: "Totalling error on the script", entries: [fix] });
    sheet = await m.getMarksSheet(principal, ref);
    expect(sheet.sheet!.status).toBe("APPROVED");
    expect(sheet.rows.find((r) => r.enrollmentId === enr[1])!.mark).toMatchObject({ theory: "32", corrected: true });
    await expect(m.lockExamMarks(admin, { id: examId, version: (await exam()).version })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.lockExamMarks(vp, { id: examId, version: (await exam()).version });
    expect((await exam()).status).toBe("LOCKED");
  });

  it("publishes one snapshot per student; the class teacher adds a remark and prints; results are then fixed", async () => {
    await expect(m.publishResults(admin, { id: examId, version: (await exam()).version })).rejects.toBeInstanceOf(m.ForbiddenError);
    const r = await m.publishResults(principal, { id: examId, version: (await exam()).version });
    expect(r.reportCards).toBe(3);
    const res = await m.getSectionResults(classTeacher, { examinationId: examId, sectionId });
    expect(res.mode).toBe("published");
    const byCode = new Map(res.cards.map((c) => [c.snapshot.student.code, c]));
    const p1 = byCode.get(`${tag}-STU-1`)!.snapshot;
    // Maths 88/100 + Art 45.5/50 = 133.5/150 = 89 % → A.
    expect(p1.total).toMatchObject({ obtained: "133.5", max: 150, percent: "89.00", grade: "A", result: "PASS" });
    const p2 = byCode.get(`${tag}-STU-2`)!.snapshot;
    expect(p2.total).toMatchObject({ obtained: "37", max: 100, grade: "C", result: "PASS" });
    const p3 = byCode.get(`${tag}-STU-3`)!.snapshot;
    expect(p3.total).toMatchObject({ obtained: "0", result: "FAIL" }); // AB counts 0, below the 33 % pass mark
    expect(p1.rank).toBeNull(); // show_rank off by default
    const card = byCode.get(`${tag}-STU-1`)!;
    await expect(m.setReportCardRemark(otherTeacher, { id: card.id, version: card.version, remark: "x" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.setReportCardRemark(classTeacher, { id: card.id, version: card.version, remark: "Steady progress." });
    const pdf = await m.renderReportCardPdf(classTeacher, card.id);
    expect(pdf.pdf.subarray(0, 4).toString()).toBe("%PDF");
    await expect(m.renderReportCardPdf(otherTeacher, card.id)).rejects.toBeInstanceOf(m.NotFoundError);
    // Fixed: no further marks changes, no unlock.
    const e = await exam();
    await expect(m.unlockExamMarks(principal, { id: examId, version: e.version })).rejects.toBeInstanceOf(m.ConflictError);
    const math = e.subjects.find((s) => s.classSubject.id === csMath)!.id;
    const sheet = await m.getMarksSheet(principal, { examSubjectId: math, sectionId });
    expect(sheet.canCorrect).toBe(false);
    expect(await m.prisma.auditLog.count({ where: { action: "examination.publish", entityId: examId } })).toBe(1);
  });
});
