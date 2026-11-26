import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { FIXTURE_DOB, freeFixtureYear } from "./fixture-year";

/**
 * PENDING until migrations 20261110000000 + 20261111000000 are applied to the Neon "test" branch and
 * TEST_DATABASE_URL is configured (separate owner approval); skipped otherwise (KI-043). Phase 2B S7:
 * directory scope (ALL vs class teacher), field-level edits, permanent IDs, status changes (enrollment LEFT,
 * roll number kept, draft stale), CSV export (RBAC, D8, audit without data). Synthetic data only.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/students/roll-numbers.service")),
  ...(await import("@/modules/students/students.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);
const FIXTURE_YEAR = enabled ? await freeFixtureYear(m.prisma, 1) : 2000;

describe.skipIf(!enabled)("student records (integration)", () => {
  const run = `sr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  // A PAST synthetic session (2000–2019; other suites use 2200+): leaving dates may not be in the future,
  // so the status-change success path needs enrollments that started before today.
  const year = FIXTURE_YEAR; // a free past year on Test (fixture-year.ts)
  const sessionName = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, principal: Ctx, officer: Ctx, classTeacher: Ctx, otherTeacher: Ctx, accountant: Ctx;
  let classTeacherId: string;
  let sessionId: string, classId: string, sectionA: string, sectionB: string;
  const students: Record<string, { studentId: string; studentCode: string; admissionNo: string }> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const studentVersion = async (id: string) => (await m.prisma.student.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, lastName: string, sectionId: string) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName, dob: FIXTURE_DOB, gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: "Synthetic Parent", phone: `96${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    return m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, pr, ao, ct, t2, acc] = await Promise.all([
      user("root", "SUPER_ADMIN"),
      user("pr", "PRINCIPAL"),
      user("ao", "ADMISSION_OFFICER"),
      user("ct", "CLASS_TEACHER"),
      user("t2", "CLASS_TEACHER"),
      user("acc", "ACCOUNTANT"),
    ]);
    classTeacherId = ct.id;
    // H4 (Phase 3A M3b): class teachers need a linked ACTIVE, TEACHING employee.
    await (await import("./staff-fixture")).linkTeachingEmployee(m.prisma, tag, ct.id);
    [admin, principal, officer, classTeacher, otherTeacher, accountant] = await Promise.all([root, pr, ao, ct, t2, acc].map((u) => ctxFor(u.id)));
    sessionId = (await m.createAcademicSession(admin, { name: sessionName, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(admin, sessionId, "ACTIVE");
    classId = (await m.createClass(admin, { code: `${tag}-S`, name: `${run} Class S`, numericLevel: 5, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    const [a, b] = await m.createSectionsBulk(admin, { academicSessionId: sessionId, classId, names: ["A", "B"], capacity: 40 });
    [sectionA, sectionB] = [a.id, b.id];
    await m.assignClassTeacher(admin, { id: sectionA, version: 1, userId: classTeacherId });
    students.ananya = await admit("Ananya", "Das", sectionA);
    students.rohit = await admit("Rohit", "Singh", sectionA);
    students.zoya = await admit("Zoya", "Ahmed", sectionB);
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    await (await import("./staff-fixture")).removeStaffFixtures(prisma, tag);
    if (!sessionId) return void (await prisma.user.deleteMany({ where: { username: { startsWith: run } } }), await prisma.$disconnect()); // setup failed early
    const ids = Object.values(students).map((s) => s.studentId);
    const guardians = await prisma.studentGuardian.findMany({ where: { studentId: { in: ids } }, select: { guardianId: true } });
    await prisma.rollNumberBatch.deleteMany({ where: { sectionId: { in: [sectionA, sectionB].filter(Boolean) } } });
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentStatusChange.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentEnrollment.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    await prisma.guardian.deleteMany({ where: { id: { in: guardians.map((g) => g.guardianId) } } });
    await prisma.sequenceCounter.deleteMany({ where: { key: { in: [`student_id:${year}`, `admission_no:${year}`, `application_no:${sessionName}`] } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("directory: ALL sees the session's students; search by name, student ID and admission number", async () => {
    const all = await m.listStudents(admin, { academicSessionId: sessionId, page: 1, pageSize: 25 });
    expect(all.rows.map((r) => r.fullName)).toEqual(["Ananya Das", "Rohit Singh", "Zoya Ahmed"]);
    expect((await m.listStudents(admin, { academicSessionId: sessionId, q: "  ananya ", page: 1, pageSize: 25 })).total).toBe(1);
    expect((await m.listStudents(admin, { q: students.zoya.studentCode.toLowerCase(), page: 1, pageSize: 25 })).rows[0].fullName).toBe("Zoya Ahmed");
    expect((await m.listStudents(admin, { q: students.rohit.admissionNo, page: 1, pageSize: 25 })).rows[0].fullName).toBe("Rohit Singh");
    expect((await m.listStudents(admin, { sectionId: sectionB, page: 1, pageSize: 25 })).total).toBe(1);
  });

  it("class teacher sees only their own section; other students look missing (no oracle)", async () => {
    const mine = await m.listStudents(classTeacher, { page: 1, pageSize: 25 });
    expect(mine.rows.map((r) => r.fullName).sort()).toEqual(["Ananya Das", "Rohit Singh"]);
    await expect(m.getStudent(classTeacher, students.zoya.studentId)).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.listStudents(otherTeacher, { page: 1, pageSize: 25 })).total).toBe(0);
    await expect(m.readStudentPhoto(classTeacher, students.zoya.studentId)).rejects.toBeInstanceOf(m.NotFoundError);
  });

  it("profile: guardians, enrollment, application link only for ALL-scope admission readers; no documents for the class teacher", async () => {
    const p = await m.getStudent(admin, students.ananya.studentId);
    expect(p.guardians).toHaveLength(1);
    expect(p.enrollments[0].section.id).toBe(sectionA);
    expect(p.application?.id).toBeTruthy();
    const ct = await m.getStudent(classTeacher, students.ananya.studentId);
    expect(ct.documents).toBeNull();
    expect(ct.application).toBeNull();
  });

  it("field-level edits: admin edits names (full name recomputed); class teacher contact only; IDs unchanged; audited", async () => {
    const id = students.ananya.studentId;
    await m.updateStudent(admin, { id, version: await studentVersion(id), firstName: "Anaya", middleName: null, lastName: "Das", phone: null, email: null, address });
    const row = await m.prisma.student.findUniqueOrThrow({ where: { id }, select: { fullName: true, fullNameNormalized: true, studentCode: true, admissionNo: true } });
    expect(row).toMatchObject({ fullName: "Anaya Das", fullNameNormalized: "anaya das", studentCode: students.ananya.studentCode, admissionNo: students.ananya.admissionNo });

    await m.updateStudent(classTeacher, { id, version: await studentVersion(id), phone: "9876500001", email: null, address: { ...address, city: "Othertown" } });
    await expect(m.updateStudent(classTeacher, { id, version: await studentVersion(id), firstName: "Changed", phone: "9876500001", email: null, address })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.updateStudent(classTeacher, { id: students.zoya.studentId, version: await studentVersion(students.zoya.studentId), phone: null, email: null, address })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.updateStudent(accountant, { id, version: await studentVersion(id), phone: null, email: null, address })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.updateStudent(admin, { id, version: 1, phone: null, email: null, address })).rejects.toBeInstanceOf(m.ConflictError); // stale version

    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student.update", entityId: id }, orderBy: { at: "desc" }, select: { before: true, after: true } });
    expect(log.after).toMatchObject({ fields: ["phone", "address"] });
  });

  it("guardian contact: class teacher may change the phone, not the name", async () => {
    const id = students.rohit.studentId;
    const g = (await m.getStudent(admin, id)).guardians[0].guardian;
    await m.updateGuardian(classTeacher, { studentId: id, guardianId: g.id, phone: "9876500002", altPhone: null, email: null });
    expect((await m.prisma.guardian.findUniqueOrThrow({ where: { id: g.id } })).phone).toBe("9876500002");
    await expect(m.updateGuardian(classTeacher, { studentId: id, guardianId: g.id, name: "Other Name", phone: "9876500002", altPhone: null, email: null })).rejects.toBeInstanceOf(m.ForbiddenError);
    // A guardian of another student can't be edited through this student.
    const other = (await m.getStudent(admin, students.zoya.studentId)).guardians[0].guardian;
    await expect(m.updateGuardian(admin, { studentId: id, guardianId: other.id, phone: "9876500003", altPhone: null, email: null })).rejects.toBeInstanceOf(m.NotFoundError);
  });

  it("export: School Admin gets CSV; Accountant (D8), Principal and class teacher are refused; audit has no data", async () => {
    const r = await m.exportStudentRows(admin, { academicSessionId: sessionId });
    expect(r.rows).toBe(3);
    expect(r.csv.split("\r\n")[0]).toContain("Student ID,Admission no.,Full name");
    for (const c of [accountant, principal, classTeacher]) await expect(m.exportStudentRows(c, { academicSessionId: sessionId })).rejects.toBeInstanceOf(m.ForbiddenError);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student.export" }, orderBy: { at: "desc" }, select: { after: true } });
    expect(JSON.stringify(log.after)).not.toContain("Ahmed");
    expect(log.after).toMatchObject({ rows: 3, format: "csv" });
  });

  it("status change: needs student.transfer; dates checked; enrollment LEFT, finalized roll number kept, history row", async () => {
    // Finalize section A's roll numbers first (Ananya → 1, Rohit → 2).
    await m.generateRollNumbers(admin, sectionA, null);
    const batch = await m.prisma.rollNumberBatch.findUniqueOrThrow({ where: { sectionId: sectionA }, select: { version: true } });
    const code = (await m.prisma.section.findUniqueOrThrow({ where: { id: sectionA }, select: { code: true } })).code;
    await m.finalizeRollNumbers(principal, sectionA, batch.version, code);

    const id = students.rohit.studentId;
    const input = (over: Partial<{ effectiveDate: string; toStatus: "TRANSFERRED" | "WITHDRAWN" | "GRADUATED" }> = {}) =>
      studentVersion(id).then((version) => ({ id, version, toStatus: "TRANSFERRED" as const, effectiveDate: `${year}-09-01`, reason: "Family moved to another city", ...over }));
    await expect(m.changeStudentStatus(principal, await input())).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.changeStudentStatus(classTeacher, await input())).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.changeStudentStatus(admin, await input({ effectiveDate: `${year}-05-01` }))).rejects.toThrow(/before the student joined/);
    await expect(m.changeStudentStatus(admin, await input({ effectiveDate: "2999-01-01" }))).rejects.toThrow(/future/);

    const r = await m.changeStudentStatus(admin, await input());
    expect(r).toMatchObject({ status: "TRANSFERRED", enrollmentsLeft: 1 });
    const en = await m.prisma.studentEnrollment.findFirstOrThrow({ where: { studentId: id }, select: { status: true, leftOn: true, rollNumber: { select: { rollNumber: true } } } });
    expect(en.status).toBe("LEFT");
    expect(en.leftOn?.toISOString().slice(0, 10)).toBe(`${year}-09-01`);
    expect(en.rollNumber?.rollNumber).toBe(2); // kept, never reused
    expect(await m.prisma.studentStatusChange.count({ where: { studentId: id, toStatus: "TRANSFERRED" } })).toBe(1);
    await expect(m.changeStudentStatus(admin, await input({ toStatus: "WITHDRAWN" }))).rejects.toThrow(/already transferred/);

    // The class teacher no longer sees a student who left; the directory's status filter finds them for ALL.
    await expect(m.getStudent(classTeacher, id)).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.listStudents(admin, { academicSessionId: sessionId, status: "TRANSFERRED", page: 1, pageSize: 25 })).rows.map((x) => x.id)).toEqual([id]);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student.status_change", entityId: id }, select: { after: true } });
    expect(JSON.stringify(log.after)).not.toContain("Family moved"); // the reason stays in the status-change row only
  });
});
