import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until migrations 20261110000000 + 20261111000000 are applied to the Neon "test" branch and
 * TEST_DATABASE_URL is configured (separate owner approval); skipped otherwise (KI-043). Phase 2B S6:
 * roll numbers — draft → finalize → append on later approvals → corrections; RBAC; audit.
 * Synthetic data only; everything removed in afterAll.
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
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("roll numbers (integration)", () => {
  const run = `rn${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2200 + Math.floor(Math.random() * 600);
  const sessionName = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, principal: Ctx, officer: Ctx, teacher: Ctx;
  let sessionId: string, classId: string, sectionId: string, sectionCode: string;
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const version = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const batchVersion = async () => (await m.prisma.rollNumberBatch.findUniqueOrThrow({ where: { sectionId } })).version;
  /** Approve a synthetic child with the given name into the section. */
  async function admit(firstName: string, lastName: string, dob = "2019-05-01") {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName, dob, gender: "MALE" });
    await m.updateGuardiansStep(officer, { id, version: await version(id), guardians: [{ relation: "FATHER", name: "Synthetic Parent", phone: `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: false }] });
    await m.updateContactStep(officer, { id, version: await version(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await version(id));
    await m.setSection(principal, id, await version(id), sectionId);
    return m.approveApplication(principal, { id, version: await version(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
  }
  const sheetNames = async () => (await m.getRollNumberSheet(admin, sectionId)).batch!.numbers.map((n) => `${n.rollNumber} ${n.enrollment.student.fullName}`);

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, pr, ao, t] = await Promise.all([user("root", "SUPER_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER"), user("t", "TEACHER")]);
    [admin, principal, officer, teacher] = await Promise.all([ctxFor(root.id), ctxFor(pr.id), ctxFor(ao.id), ctxFor(t.id)]);
    sessionId = (await m.createAcademicSession(admin, { name: sessionName, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(admin, sessionId, "ACTIVE");
    classId = (await m.createClass(admin, { code: `${tag}-N`, name: `${run} Class N`, numericLevel: 4, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    const [sec] = await m.createSectionsBulk(admin, { academicSessionId: sessionId, classId, names: ["A"], capacity: 40 });
    [sectionId, sectionCode] = [sec.id, sec.code];
    for (const [f, l] of [["Rohit", "Singh"], ["amit", "kumar"], ["Zoya", "Ahmed"], ["Ananya", "Das"], ["Rahul", "Sharma"]]) await admit(f, l);
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    const apps = await prisma.admissionApplication.findMany({ where: { academicSessionId: sessionId }, select: { studentId: true } });
    const studentIds = apps.map((a) => a.studentId).filter((x): x is string => !!x);
    const guardians = await prisma.studentGuardian.findMany({ where: { studentId: { in: studentIds } }, select: { guardianId: true } });
    await prisma.rollNumberBatch.deleteMany({ where: { sectionId } }); // numbers CASCADE
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.guardian.deleteMany({ where: { id: { in: guardians.map((g) => g.guardianId) } } });
    await prisma.sequenceCounter.deleteMany({ where: { key: { in: [`student_id:${year}`, `admission_no:${year}`, `application_no:${sessionName}`] } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("approvals before any batch get no number; the preview has no side effects", async () => {
    const sheet = await m.getRollNumberSheet(admin, sectionId);
    expect(sheet.batch).toBeNull();
    expect(sheet.preview.map((p) => `${p.rollNumber} ${p.fullName}`)).toEqual(["1 amit kumar", "2 Ananya Das", "3 Rahul Sharma", "4 Rohit Singh", "5 Zoya Ahmed"]);
    expect(await m.prisma.rollNumberBatch.count({ where: { sectionId } })).toBe(0);
  });

  it("generate → draft in alphabetical order; a stale draft can't be finalized; regenerate → finalize", async () => {
    await m.generateRollNumbers(officer, sectionId, null); // Admission Officer generates (D3)
    expect(await sheetNames()).toEqual(["1 amit kumar", "2 Ananya Das", "3 Rahul Sharma", "4 Rohit Singh", "5 Zoya Ahmed"]);
    await admit("Bhavya", "Rao"); // joins while the batch is only a DRAFT → no number, draft now stale
    await expect(m.finalizeRollNumbers(principal, sectionId, await batchVersion(), sectionCode)).rejects.toThrow(/Generate the draft again/);
    await expect(m.generateRollNumbers(officer, sectionId, 1 + (await batchVersion()))).rejects.toThrow(/changed by someone else/);
    await m.generateRollNumbers(officer, sectionId, await batchVersion());
    await expect(m.finalizeRollNumbers(principal, sectionId, await batchVersion(), "WRONG")).rejects.toBeInstanceOf(m.ValidationError);
    await m.finalizeRollNumbers(principal, sectionId, await batchVersion(), sectionCode.toLowerCase());
    expect(await sheetNames()).toEqual(["1 amit kumar", "2 Ananya Das", "3 Bhavya Rao", "4 Rahul Sharma", "5 Rohit Singh", "6 Zoya Ahmed"]);
    await expect(m.generateRollNumbers(officer, sectionId, await batchVersion())).rejects.toThrow(/finalized/);
  });

  it("after finalization, later admissions are appended (even concurrently) and nothing is re-sorted", async () => {
    const before = await sheetNames();
    const [a, b] = await Promise.all([admit("Aarav", "Bose"), admit("Kiran", "Mehta")]);
    expect([a.rollNumber, b.rollNumber].sort()).toEqual([7, 8]);
    const after = await sheetNames();
    expect(after.slice(0, 6)).toEqual(before); // existing numbers untouched
    const appended = await m.prisma.studentRollNumber.findMany({ where: { batch: { sectionId }, rollNumber: { in: [7, 8] } }, select: { source: true } });
    expect(appended.every((x) => x.source === "APPENDED")).toBe(true);
  }, 120_000);

  it("corrections: free number + reason, audited; a taken number is refused", async () => {
    const zoya = await m.prisma.studentRollNumber.findFirstOrThrow({ where: { batch: { sectionId }, enrollment: { student: { firstName: "Zoya" } } }, select: { enrollmentId: true } });
    await expect(m.correctRollNumber(principal, { sectionId, enrollmentId: zoya.enrollmentId, rollNumber: 1, reason: "Synthetic test", version: await batchVersion() })).rejects.toThrow(/already belongs/);
    await m.correctRollNumber(principal, { sectionId, enrollmentId: zoya.enrollmentId, rollNumber: 20, reason: "Synthetic correction", version: await batchVersion() });
    const row = await m.prisma.studentRollNumber.findUniqueOrThrow({ where: { enrollmentId: zoya.enrollmentId } });
    expect([row.rollNumber, row.source]).toEqual([20, "CORRECTED"]);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "rollnumber.correct" }, orderBy: { at: "desc" }, select: { before: true, after: true } });
    expect([(log.before as { rollNumber: number }).rollNumber, (log.after as { rollNumber: number; reason: string }).reason]).toEqual([6, "Synthetic correction"]);
    // The next late admission gets 21 (one past the highest ever given), not a reused 6.
    expect((await admit("Neha", "Iyer")).rollNumber).toBe(21);
  });

  it("RBAC: generate (School Admin / Admission Officer), finalize (Principal / VP), correct (Principal); Teacher none", async () => {
    await expect(m.finalizeRollNumbers(officer, sectionId, await batchVersion(), sectionCode)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.correctRollNumber(officer, { sectionId, enrollmentId: "x", rollNumber: 30, reason: "nope", version: 1 })).rejects.toBeInstanceOf(m.ForbiddenError);
    for (const call of [() => m.generateRollNumbers(teacher, sectionId, null), () => m.getRollNumberSheet(teacher, sectionId), () => m.listSectionsForRollNumbers(teacher, sessionId)]) {
      await expect(call()).rejects.toBeInstanceOf(m.ForbiddenError);
    }
  });
});
