import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 2B security fixes — database behaviour (docs/SECURITY_AUDIT_2026-11-10_PHASE_2B.md). PENDING: written
 * 2026-11-10, not yet run (no database access was approved for the fix work). Runs only via
 * `npm run test:integration`, behind the S-05 target guard (Test branch allow-list + live identity).
 *   S-02 closing a session ends class-teacher access; a class teacher can be removed from a closed session
 *   S-03 attempts from one IP don't block the same user from another IP; admin unlock clears the limiter
 *   S-09 losing the teacher role releases class-teacher sections (no inherited student access)
 *   S-13 a class teacher can't edit a guardian shared with a student outside their section; School Admin can
 *   S-14 the creator of an application can't approve it; another approver can
 * Past synthetic session (2000–2019) so leaving/closing rules apply; synthetic data only; cleaned up by session.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/auth/password")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/identity/auth.service")),
  ...(await import("@/modules/identity/users.service")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/students/students.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("Phase 2B security fixes (integration)", () => {
  const run = `sf${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  const sessionName = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, admin: Ctx, admin2: Ctx, principal: Ctx, officer: Ctx, ct: Ctx, ct2: Ctx;
  let ctId: string, ct2Id: string;
  let sessionId: string, classId: string, secA: string, secB: string, secC: string;
  const students: Record<string, { studentId: string }> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const sharedPhone = `95${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string, password = "x") {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const passwordHash = password === "x" ? "x" : await m.hashPassword(password);
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash, roles: { create: { roleId: role.id } } } });
  }
  const v = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const sv = async (id: string) => (await m.prisma.section.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function ready(first: string, sectionId: string, phone: string, by: Ctx = officer) {
    const { id } = await m.createDraft(by, { academicSessionId: sessionId, classId, firstName: first, middleName: null, lastName: "Demo", dob: "1995-05-01", gender: "FEMALE" });
    await m.updateGuardiansStep(by, { id, version: await v(id), guardians: [{ relation: "MOTHER", name: "Synthetic Parent", phone, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(by, { id, version: await v(id), phone: null, email: null, address });
    await m.submitApplication(by, id, await v(id));
    await m.setSection(principal, id, await v(id), sectionId);
    return id;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const u = {
      root: await user("root", "SUPER_ADMIN"),
      admin: await user("adm", "SCHOOL_ADMIN"),
      admin2: await user("adm2", "SCHOOL_ADMIN"),
      principal: await user("pr", "PRINCIPAL"),
      officer: await user("ao", "ADMISSION_OFFICER"),
      ct: await user("ct", "CLASS_TEACHER"),
      ct2: await user("ct2", "CLASS_TEACHER"),
    };
    [ctId, ct2Id] = [u.ct.id, u.ct2.id];
    [root, admin, admin2, principal, officer, ct, ct2] = await Promise.all([u.root, u.admin, u.admin2, u.principal, u.officer, u.ct, u.ct2].map((x) => ctxFor(x.id)));
    sessionId = (await m.createAcademicSession(root, { name: sessionName, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-K`, name: `${run} Class K`, numericLevel: 4, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    const [a, b, c] = await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A", "B", "C"], capacity: 40 });
    [secA, secB, secC] = [a.id, b.id, c.id];
    await m.assignClassTeacher(root, { id: secA, version: 1, userId: ctId });
    await m.assignClassTeacher(root, { id: secC, version: 1, userId: ct2Id });
    for (const [first, sec] of [["Asha", secA], ["Bina", secB], ["Chitra", secC]] as const) {
      const id = await ready(first, sec, `96${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
      students[first] = await m.approveApplication(principal, { id, version: await v(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    }
    // Siblings sharing one guardian across sections A and B (explicit link at approval, D9).
    const sibA = await ready("Sita", secA, sharedPhone);
    students.Sita = await m.approveApplication(principal, { id: sibA, version: await v(sibA), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    const guardianId = (await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId: students.Sita.studentId } })).guardianId;
    const sibB = await ready("Gita", secB, sharedPhone);
    const ag = await m.prisma.admissionGuardian.findFirstOrThrow({ where: { applicationId: sibB }, select: { id: true } });
    students.Gita = await m.approveApplication(principal, { id: sibB, version: await v(sibB), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: { [ag.id]: guardianId } });
  }, 300_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!sessionId) return void (await prisma.user.deleteMany({ where: { username: { startsWith: run } } }), await prisma.$disconnect());
    const studentIds = (await prisma.student.findMany({ where: { admittedSessionId: sessionId }, select: { id: true } })).map((s) => s.id);
    const guardianIds = [...new Set((await prisma.studentGuardian.findMany({ where: { studentId: { in: studentIds } }, select: { guardianId: true } })).map((g) => g.guardianId))];
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { admittedSessionId: sessionId } });
    await prisma.guardian.deleteMany({ where: { id: { in: guardianIds }, students: { none: {} }, applicantLinks: { none: {} } } });
    await prisma.sequenceCounter.deleteMany({ where: { key: { in: [`student_id:${year}`, `admission_no:${year}`, `application_no:${sessionName}`] } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("S-13: a class teacher can't change a guardian shared with a student outside their section; School Admin can", async () => {
    const g = (await m.getStudent(admin, students.Sita.studentId)).guardians[0].guardian;
    await expect(m.updateGuardian(ct, { studentId: students.Sita.studentId, guardianId: g.id, phone: "9876500011", altPhone: null, email: null })).rejects.toBeInstanceOf(m.ForbiddenError);
    expect((await m.prisma.guardian.findUniqueOrThrow({ where: { id: g.id } })).phone).toBe(sharedPhone); // unchanged
    await m.updateGuardian(admin, { studentId: students.Sita.studentId, guardianId: g.id, phone: "9876500011", altPhone: null, email: null });
    expect((await m.prisma.guardian.findUniqueOrThrow({ where: { id: g.id } })).phone).toBe("9876500011");
    // A guardian linked only inside the section stays editable for the class teacher.
    const own = (await m.getStudent(admin, students.Asha.studentId)).guardians[0].guardian;
    await m.updateGuardian(ct, { studentId: students.Asha.studentId, guardianId: own.id, phone: "9876500012", altPhone: null, email: null });
  });

  it("S-14: the creator can't approve their own application; another School Admin can", async () => {
    const id = await ready("Self", secB, `97${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, admin);
    await expect(m.approveApplication(admin, { id, version: await v(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} })).rejects.toThrow(/must be approved by another/);
    expect((await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id } })).status).not.toBe("APPROVED");
    const r = await m.approveApplication(admin2, { id, version: await v(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    expect(r.studentCode).toBeTruthy();
  });

  it("S-09: losing the class-teacher role releases the section — a later ASSIGNED role inherits nothing", async () => {
    expect((await m.listStudents(ct2, { page: 1, pageSize: 25 })).total).toBe(1);
    await m.updateUser(root, { id: ct2Id, displayName: "Synthetic ct2", email: null, roleKeys: ["TRANSPORT_MANAGER"] });
    expect((await m.prisma.section.findUniqueOrThrow({ where: { id: secC } })).classTeacherId).toBeNull();
    const tm = await ctxFor(ct2Id);
    expect((await m.listStudents(tm, { page: 1, pageSize: 25 })).total).toBe(0);
    expect(await m.prisma.auditLog.count({ where: { action: "section.class_teacher_unassign", entityId: secC } })).toBe(1);
  });

  it("S-02: closing the session ends class-teacher access; the teacher can then be removed from the closed section", async () => {
    expect((await m.listStudents(ct, { page: 1, pageSize: 25 })).total).toBeGreaterThan(0);
    await m.changeAcademicSessionStatus(root, sessionId, "CLOSED");
    expect((await m.listStudents(ct, { page: 1, pageSize: 25 })).total).toBe(0);
    await expect(m.getStudent(ct, students.Asha.studentId)).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.readStudentPhoto(ct, students.Asha.studentId)).rejects.toBeInstanceOf(m.NotFoundError);
    // Assigning stays refused on a closed session; removing is allowed (access change only).
    await expect(m.assignClassTeacher(root, { id: secB, version: await sv(secB), userId: ctId })).rejects.toThrow(/closed/i);
    await m.unassignClassTeacher(root, secA, await sv(secA));
    expect((await m.prisma.section.findUniqueOrThrow({ where: { id: secA } })).classTeacherId).toBeNull();
  });

  it("S-03: 10 attempts from one IP don't block the user from another IP; admin unlock clears the limiter", async () => {
    const pw = "Correct horse battery 7";
    const target = await user("login", "TEACHER", pw);
    const username = target.username;
    for (let i = 0; i < 10; i++) await expect(m.login({ username, password: "wrong password!!", remember: false }, { ipHash: "attacker-ip" })).rejects.toBeDefined();
    await expect(m.login({ username, password: pw, remember: false }, { ipHash: "attacker-ip" })).rejects.toBeInstanceOf(m.RateLimitedError);
    // The account lock (5 failures) still applies — unlock it as an admin, then the real user signs in elsewhere.
    await m.unlockUser(root, target.id);
    const ok = await m.login({ username, password: pw, remember: false }, { ipHash: "user-ip" });
    expect(ok.token).toBeTruthy();
    // After unlock, the attacker IP's (user, IP) bucket was cleared too.
    expect((await m.login({ username, password: pw, remember: false }, { ipHash: "attacker-ip" })).token).toBeTruthy();
  });
});
