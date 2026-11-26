import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6C-M4 — optional student accounts against real Postgres (PHASE_6_PLAN.md §6 6C-M4; P14, P16, P17). PENDING
 * until KI-059 (and migrations B–D on Test). Synthetic data only; the portal settings are changed for the run and
 * restored afterwards.
 * - setting off / below the minimum class / no activated parent → provisioning refused;
 * - SELF only: the student's own reads work; a sibling's id → the same 404; never fees, never the UPI page;
 * - PARENTS notices never reach a student account;
 * - leaving deactivates the student's own account in the same transaction (the parent keeps the leaver window);
 * - review M1: the setting turned off / the minimum class raised / the last consenting parent switched off or blocked
 *   switches the account off (sessions, pending codes, audit); nothing revives it by itself.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/format")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/students/family-accounts.service")),
  ...(await import("@/modules/students/students.service")),
  ...(await import("@/modules/students/students.portal")),
  ...(await import("@/modules/academic/homework.portal")),
  ...(await import("@/modules/fees/fees.portal")),
  ...(await import("@/modules/fees/payment-claims.portal")),
  ...(await import("@/modules/notices/notices.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("student accounts (integration)", () => {
  const run = `sa${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, parentCtx: Ctx;
  let sessionId: string, sectionId: string, juniorSection: string, olderId: string, siblingId: string, juniorId: string, guardianId: string, parentUserId: string;
  let today: string, window: { today: string; leaverAccessDays: number };
  let featuresBefore: unknown = null;
  const settings = (studentAccounts: boolean) => m.updatePortalPaymentSettings(admin, { payeeName: "Demo Public School", vpa: "demo.school@examplebank", leaverAccessDays: 180, studentAccounts, studentMinClassLevel: 9 });
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;
  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  async function pupil(n: number, section: string, start: Date) {
    const s = await m.prisma.student.create({
      data: { studentCode: `${tag}-STU-${n}`, admissionNo: `${tag}-ADM-${n}`, firstName: `Synth${n}`, fullName: `Synthetic Pupil ${n}`, fullNameNormalized: `synthetic pupil ${n}`, dob: d("2011-06-0" + n), gender: "OTHER", admissionDate: start, admittedSessionId: sessionId },
    });
    await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId: section, enrolledOn: start } });
    await m.prisma.studentGuardian.create({ data: { studentId: s.id, guardianId, relation: "MOTHER", isPrimary: true } });
    return s.id;
  }
  /** Simulates the activation the student does at /activate (consent recorded by the parent's earlier activation). */
  async function activatedStudentCtx(studentId: string) {
    const u = await m.prisma.user.findFirstOrThrow({ where: { studentId }, select: { id: true } });
    await m.prisma.user.update({ where: { id: u.id }, data: { privacyConsentAt: new Date(), privacyConsentVersion: "1" } });
    return login(u.id);
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    admin = await login((await staff("sa", "SCHOOL_ADMIN")).id);
    featuresBefore = ((await m.prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { features: true } }))?.features ?? null) as unknown;
    today = m.todayInTimeZone();
    window = { today, leaverAccessDays: 180 };
    const start = new Date(d(today).getTime() - 60 * 86_400_000);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-now`, startDate: start, endDate: new Date(d(today).getTime() + 200 * 86_400_000), status: "ACTIVE" } })).id;
    const c9 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C9`, name: `${run} nine`, nameKey: `${run} nine`, numericLevel: 9 } })).id;
    const c5 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C5`, name: `${run} five`, nameKey: `${run} five`, numericLevel: 5 } })).id;
    sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: c9, name: "A", nameKey: "a", code: `${tag}C9-A`, capacity: 40 } })).id;
    juniorSection = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: c5, name: "A", nameKey: "a", code: `${tag}C5-A`, capacity: 40 } })).id;
    guardianId = (await m.prisma.guardian.create({ data: { name: "Synthetic Guardian SA", phone: `108${String(Date.now() % 1e6).padStart(6, "0")}9` } })).id;
    olderId = await pupil(1, sectionId, start);
    siblingId = await pupil(2, sectionId, start);
    juniorId = await pupil(3, juniorSection, start);
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" } });
    parentUserId = (await m.prisma.user.create({ data: { username: `${run}-pa`, displayName: "Synthetic Parent", passwordHash: "x", guardianId, roles: { create: { roleId: role.id } } } })).id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const ids = [olderId, siblingId, juniorId];
    await prisma.schoolSetting.updateMany({ where: { id: "default" }, data: { features: (featuresBefore ?? {}) as object } });
    await prisma.accountActivation.deleteMany({ where: { user: { studentId: { in: ids } } } });
    await prisma.session.deleteMany({ where: { user: { OR: [{ studentId: { in: ids } }, { username: { startsWith: run } }] } } });
    await prisma.user.deleteMany({ where: { OR: [{ studentId: { in: ids } }, { username: { startsWith: run } }] } });
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.guardian.deleteMany({ where: { id: guardianId } });
    await prisma.studentStatusChange.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.$disconnect();
  }, 180_000);

  it("provisioning is refused while the setting is off, below the minimum class, or before a parent activated", async () => {
    await settings(false);
    await expect(m.issueStudentSlip(admin, { studentId: olderId, mode: "create", username: null })).rejects.toBeInstanceOf(m.ValidationError);
    await settings(true);
    await expect(m.issueStudentSlip(admin, { studentId: olderId, mode: "create", username: null })).rejects.toThrow(/parent must activate/i); // parent not activated yet
    await m.prisma.user.update({ where: { id: parentUserId }, data: { privacyConsentAt: new Date(), privacyConsentVersion: "1" } });
    parentCtx = await login(parentUserId);
    await expect(m.issueStudentSlip(admin, { studentId: juniorId, mode: "create", username: null })).rejects.toThrow(/Class 9/);
    const [slip] = await m.issueStudentSlip(admin, { studentId: olderId, mode: "create", username: null });
    expect(slip.kind).toBe("STUDENT");
    expect(slip.username).toBe(`${tag}-stu-1`.toLowerCase());
    expect((await m.getStudentAccount(admin, olderId)).account?.status).toBe("PENDING");
    // Office-only: the parent or the student themselves can't issue slips.
    await expect(m.issueStudentSlip(parentCtx, { studentId: olderId, mode: "reset", username: null })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("review 6C-M4 L4: every seeded staff role without portal.account.manage + student.read ALL is refused", async () => {
    const { ROLES, normalizeGrant } = await import("@/lib/rbac/catalog");
    for (const role of ROLES) {
      if (role.key === "SUPER_ADMIN" || role.key === "PARENT" || role.key === "STUDENT") continue;
      const g = role.grants.map(normalizeGrant);
      const manages = g.some((x) => x.key === "portal.account.manage" && x.scope === "ALL") && g.some((x) => x.key === "student.read" && x.scope === "ALL");
      if (manages) continue;
      const ctx = await login((await staff(`r-${role.key.toLowerCase()}`, role.key)).id);
      await expect(m.issueStudentSlip(ctx, { studentId: olderId, mode: "reset", username: null }), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.setStudentAccountActive(ctx, { studentId: olderId, active: false, reason: "Synthetic" }), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.getStudentAccount(ctx, olderId), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
    }
  }, 120_000);

  it("SELF only: own reads work; a sibling's id is the same 404; never fees or the UPI page", async () => {
    const student = await activatedStudentCtx(olderId);
    expect(student.portal?.kind).toBe("STUDENT");
    expect((await m.listPortalChildren(student, window)).map((c) => c.id)).toEqual([olderId]);
    expect((await m.getPortalStudentProfile(student, olderId, window)).fullName).toBe("Synthetic Pupil 1");
    await expect(m.getPortalStudentProfile(student, siblingId, window)).rejects.toThrow("Not found.");
    await expect(m.listPortalHomework(student, siblingId, window)).rejects.toThrow("Not found.");
    await expect(m.getPortalFeeLedger(student, olderId, window)).rejects.toThrow("Not found.");
    await expect(m.getPortalPayPage(student, olderId, window)).rejects.toThrow("Not found.");
  });

  it("PARENTS notices reach the parent, never the student account", async () => {
    const student = await activatedStudentCtx(olderId);
    const base = { academicSessionId: sessionId, title: `${run} parents only`, body: "Synthetic", scope: "SECTION" as const, status: "PUBLISHED" as const, publishAt: new Date(Date.now() - 60_000), publishedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) };
    const n = await m.prisma.notice.create({ data: { ...base, audience: "PARENTS" } });
    await m.prisma.noticeTarget.create({ data: { noticeId: n.id, academicSessionId: sessionId, scope: "SECTION", sectionId } });
    expect((await m.listPortalNotices(parentCtx, window)).map((x) => x.id)).toContain(n.id);
    expect((await m.listPortalNotices(student, window)).map((x) => x.id)).not.toContain(n.id);
    await expect(m.openPortalNotice(student, n.id, window)).rejects.toThrow("Not found.");
    await m.prisma.noticeTarget.deleteMany({ where: { noticeId: n.id } });
    await m.prisma.notice.delete({ where: { id: n.id } });
  });

  it("leaving deactivates the student's own account in the same transaction; the parent keeps theirs", async () => {
    const s = await m.prisma.student.findUniqueOrThrow({ where: { id: olderId }, select: { version: true } });
    await m.changeStudentStatus(admin, { id: olderId, version: s.version, toStatus: "TRANSFERRED", effectiveDate: today, reason: "Synthetic transfer" });
    const account = await m.prisma.user.findFirstOrThrow({ where: { studentId: olderId }, select: { id: true, isActive: true } });
    expect(account.isActive).toBe(false);
    expect(await m.prisma.session.count({ where: { userId: account.id } })).toBe(0);
    expect(await m.prisma.auditLog.count({ where: { action: "portal.account_deactivate", entityId: account.id } })).toBe(1);
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: parentUserId }, select: { isActive: true } })).isActive).toBe(true);
    // Reactivation is refused while the student isn't studying.
    await expect(m.setStudentAccountActive(admin, { studentId: olderId, active: true, reason: "Synthetic" })).rejects.toBeInstanceOf(m.ValidationError);
  });

  // ── Review 6C-M4 M1 (owner decision 2026-11-26): an account stops when its eligibility stops ──
  const settingsWith = (studentAccounts: boolean, studentMinClassLevel: number) =>
    m.updatePortalPaymentSettings(admin, { payeeName: "Demo Public School", vpa: "demo.school@examplebank", leaverAccessDays: 180, studentAccounts, studentMinClassLevel });
  async function siblingAccount() {
    return m.prisma.user.findFirstOrThrow({ where: { studentId: siblingId }, select: { id: true, isActive: true } });
  }
  async function expectSwitchedOff(reason: string) {
    const a = await siblingAccount();
    expect(a.isActive).toBe(false);
    expect(await m.prisma.session.count({ where: { userId: a.id } })).toBe(0);
    expect(await m.prisma.accountActivation.count({ where: { userId: a.id, usedAt: null } })).toBe(0);
    const last = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "portal.account_deactivate", entityId: a.id }, orderBy: { id: "desc" }, select: { after: true } });
    expect(last.after).toMatchObject({ isActive: false, reason });
  }
  const reactivateSibling = () => m.setStudentAccountActive(admin, { studentId: siblingId, active: true, reason: "Synthetic reactivation" });

  it("turning student accounts off switches off live accounts (sessions and pending codes too); turning it on again revives none", async () => {
    await settingsWith(true, 9);
    await m.issueStudentSlip(admin, { studentId: siblingId, mode: "create", username: null }); // a pending code
    await activatedStudentCtx(siblingId); // and a live session
    const r = await settingsWith(false, 9);
    expect(r.studentAccountsSwitchedOff).toBeGreaterThanOrEqual(1);
    await expectSwitchedOff("student_accounts_off");
    expect((await settingsWith(true, 9)).studentAccountsSwitchedOff).toBe(0);
    expect((await siblingAccount()).isActive).toBe(false);
    await reactivateSibling();
    expect((await siblingAccount()).isActive).toBe(true);
  });

  it("raising the minimum class switches off accounts below it; lowering it switches off nothing", async () => {
    await activatedStudentCtx(siblingId);
    expect((await settingsWith(true, 10)).studentAccountsSwitchedOff).toBe(1);
    await expectSwitchedOff("below_min_class");
    expect((await settingsWith(true, 9)).studentAccountsSwitchedOff).toBe(0);
    await reactivateSibling();
  });

  it("switching off the only consenting parent, or blocking them from the child, ends the child's own account", async () => {
    await activatedStudentCtx(siblingId);
    await m.setFamilyAccountActive(admin, { studentId: siblingId, guardianId, active: false, reason: "Synthetic" });
    await expectSwitchedOff("no_consenting_parent");
    await m.setFamilyAccountActive(admin, { studentId: siblingId, guardianId, active: true, reason: "Synthetic" });
    expect((await siblingAccount()).isActive).toBe(false); // the parent coming back revives nothing by itself
    await reactivateSibling();

    await activatedStudentCtx(siblingId);
    await m.setGuardianPortalAccess(admin, { studentId: siblingId, guardianId, portalAccess: false });
    await expectSwitchedOff("no_consenting_parent");
    await expect(reactivateSibling()).rejects.toThrow(/parent must activate/i); // still blocked → not eligible
    await m.setGuardianPortalAccess(admin, { studentId: siblingId, guardianId, portalAccess: true });
    await reactivateSibling();
    expect((await siblingAccount()).isActive).toBe(true);
  });
});
