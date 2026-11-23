import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6B-M1 — family attendance against the real database. PENDING until KI-059. Synthetic data only.
 * The month calendar and percentages match the staff register rules; only the current enrollment; a promoted child
 * shows the new section. (Who may see what is in portal-idor.test.ts.)
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/students/student-attendance.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("portal attendance (integration)", () => {
  const run = `p6b${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, principal: Ctx, officer: Ctx, parent: Ctx;
  let sessionId: string, classId: string, sectionId: string, studentId: string, enrollmentId: string;
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const d = (s: string) => new Date(`${s}T00:00:00Z`);

  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, principal, officer] = await Promise.all([staff("root", "SUPER_ADMIN"), staff("pr", "PRINCIPAL"), staff("ao", "ADMISSION_OFFICER")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-B`, name: `${run} Class B`, numericLevel: 3, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    sectionId = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A"], capacity: 40 }))[0].id;
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName: "Meera", middleName: null, lastName: "Example", dob: "2016-05-01", gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: "Synthetic Parent Meera", phone: `105${String(Date.now() % 1e7).padStart(7, "0")}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    studentId = (await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-04-01`, duplicateOverride: null, guardianLinks: {} })).studentId;
    enrollmentId = (await m.prisma.studentEnrollment.findFirstOrThrow({ where: { studentId, academicSessionId: sessionId }, select: { id: true } })).id;
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-parent`, displayName: "Synthetic parent", passwordHash: "x", privacyConsentAt: new Date(), guardianId, roles: { create: { roleId: role.id } } } });
    parent = (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }, 120_000);

  it("the month calendar shows each school day's mark; percentages follow the register rule (half day = half)", async () => {
    // A synthetic month inside the session, with a few marks (only school days count; the weekly off is the school's).
    const month = `${year}-07`;
    const marks: [string, "PRESENT" | "ABSENT" | "HALF_DAY"][] = [[`${month}-01`, "PRESENT"], [`${month}-02`, "ABSENT"], [`${month}-03`, "HALF_DAY"]];
    for (const [date, status] of marks) await m.prisma.studentAttendance.create({ data: { academicSessionId: sessionId, enrollmentId, date: d(date), status } });
    const today = `${year + 1}-03-31`;
    const r = (await m.getPortalAttendanceMonth(parent, { studentId, month }, { today, leaverAccessDays: 180 }))!;
    expect(r.month).toBe(month);
    const byDate = new Map(r.days.map((x) => [x.date, x]));
    for (const [date, status] of marks) if (byDate.get(date)!.kind === "school") expect(byDate.get(date)!.status).toBe(status);
    const counted = marks.filter(([date]) => byDate.get(date)!.kind === "school");
    expect(r.monthSummary.marked).toBe(counted.length);
    expect(r.sessionSummary.marked).toBe(counted.length);
    // Never other students' marks or who marked them.
    expect(JSON.stringify(r)).not.toMatch(/markedBy|correction/);
  });

  it("a month outside the session or junk falls back into the session; the default is today's month (clamped)", async () => {
    const r = (await m.getPortalAttendanceMonth(parent, { studentId, month: "1999-01" }, { today: `${year}-10-15`, leaverAccessDays: 180 }))!;
    expect(r.month).toBe(`${year}-04`);
    const def = (await m.getPortalAttendanceMonth(parent, { studentId }, { today: `${year}-10-15`, leaverAccessDays: 180 }))!;
    expect(def.month).toBe(`${year}-10`);
    expect(def.nextMonth).toBeNull(); // no browsing into the future
  });

  it("a promoted child shows the new session's section (current enrollment only)", async () => {
    const next = (await m.createAcademicSession(root, { name: `${year + 1}-${String((year + 2) % 100).padStart(2, "0")}`, startDate: `${year + 1}-04-01`, endDate: `${year + 2}-03-31` })).id;
    const [newSection] = await m.createSectionsBulk(root, { academicSessionId: next, classId, names: ["B"], capacity: 40 });
    await m.prisma.studentEnrollment.update({ where: { id: enrollmentId }, data: { status: "PROMOTED" } });
    await m.prisma.studentEnrollment.create({ data: { studentId, academicSessionId: next, sectionId: newSection.id, enrolledOn: d(`${year + 1}-04-01`) } });
    const r = (await m.getPortalAttendanceMonth(parent, { studentId }, { today: `${year + 1}-05-10`, leaverAccessDays: 180 }))!;
    expect(r.sectionCode).toBe(newSection.code);
    expect(r.month).toBe(`${year + 1}-05`);
    expect(r.sessionSummary.marked).toBe(0); // last session's marks belong to last session
  });
});
