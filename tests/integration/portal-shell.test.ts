import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6A-M2 — portal context and shell rules against the real database (PHASE_6_PLAN.md §6, §7). PENDING until
 * KI-059 (TEST_DATABASE_URL + TEST_TARGET_* in .env); skipped otherwise. Synthetic data only.
 *
 * - the session lookup resolves a guardian's children; the student profile is visible for an own child only;
 * - a block (portalAccess = false), an unlink and a soft delete take effect at the next request;
 * - another family's child, a missing id and a staff context get the SAME NotFound;
 * - mixed role sets are refused (create, update); a parent account can't be given a staff role;
 * - "keep me signed in" gives 30 days to a parent, 8 h to staff.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/auth/password")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/identity/users.service")),
  ...(await import("@/modules/identity/auth.service")),
  ...(await import("@/modules/students/students.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("portal shell (integration)", () => {
  const run = `ps${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  const sessionName = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, principal: Ctx, officer: Ctx;
  let sessionId: string, classId: string, sectionA: string;
  const kids: Record<string, string> = {};
  const guardians: Record<string, string> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const window = { today: `${year}-12-01`, leaverAccessDays: 180 };
  const userIds: string[] = [];

  async function tokenFor(userId: string) {
    return (await m.createSession(userId, { long: false })).token;
  }
  async function user(suffix: string, roleKey: string, data: { guardianId?: string; studentId?: string; password?: string } = {}) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({
      data: {
        username: `${run}-${suffix}`,
        displayName: `Synthetic ${suffix}`,
        passwordHash: data.password ? await m.hashPassword(data.password) : "x",
        guardianId: data.guardianId,
        studentId: data.studentId,
        // Portal accounts are usable only after activation (consent recorded, review 6A-M3a M2).
        privacyConsentAt: roleKey === "PARENT" || roleKey === "STUDENT" ? new Date() : null,
        roles: { create: { roleId: role.id } },
      },
    });
    userIds.push(u.id);
    return u;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: "1995-05-01", gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: `Synthetic Parent ${firstName}`, phone: `104${Math.floor(1_000_000 + Math.random() * 8_999_999)}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionA);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    const link = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    return { studentId, guardianId: link.guardianId };
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, pr, ao] = await Promise.all([user("root", "SUPER_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER")]);
    [admin, principal, officer] = await Promise.all([root, pr, ao].map(async (u) => (await m.validateSessionToken(await tokenFor(u.id)))!));
    sessionId = (await m.createAcademicSession(admin, { name: sessionName, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(admin, sessionId, "ACTIVE");
    classId = (await m.createClass(admin, { code: `${tag}-P`, name: `${run} Class P`, numericLevel: 5, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    sectionA = (await m.createSectionsBulk(admin, { academicSessionId: sessionId, classId, names: ["A"], capacity: 40 }))[0].id;
    for (const name of ["Asha", "Bina"]) {
      const r = await admit(name);
      kids[name] = r.studentId;
      guardians[name] = r.guardianId;
    }
    // Asha's guardian also becomes Bina's guardian (siblings), so the family has two children.
    await m.prisma.studentGuardian.create({ data: { studentId: kids.Bina, guardianId: guardians.Asha, relation: "MOTHER" } });
  }, 120_000);

  afterAll(async () => {
    if (!enabled) return;
    await m.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  });

  it("resolves a guardian's children once per request and shows an own child's profile", async () => {
    const parent = await user("parentA", "PARENT", { guardianId: guardians.Asha });
    const ctx = (await m.validateSessionToken(await tokenFor(parent.id)))!;
    expect(ctx.portal?.kind).toBe("GUARDIAN");
    expect(ctx.portal?.children.map((c) => c.studentId).sort()).toEqual([kids.Asha, kids.Bina].sort());
    const list = await m.listPortalChildren(ctx, window);
    expect(list.map((k) => k.id).sort()).toEqual([kids.Asha, kids.Bina].sort());
    const profile = await m.getPortalStudentProfile(ctx, kids.Asha, window);
    expect(profile).toMatchObject({ id: kids.Asha, yourRelation: "Mother", className: `${run} Class P`, sectionCode: "A" });
    // Whitelist: no contact, address or guardian data leaves the service.
    expect(Object.keys(profile).sort()).toEqual(["admissionDate", "admissionNo", "className", "dob", "fullName", "gender", "id", "rollNumber", "sectionCode", "sessionName", "studentCode", "yourRelation"]);
  });

  it("another family's child, a missing id and a staff context get the same NotFound", async () => {
    const parentB = await user("parentB", "PARENT", { guardianId: guardians.Bina });
    const ctxB = (await m.validateSessionToken(await tokenFor(parentB.id)))!;
    const errs = await Promise.all([
      m.getPortalStudentProfile(ctxB, kids.Asha, window).catch((e: Error) => e),
      m.getPortalStudentProfile(ctxB, "c0000000000000000000000000", window).catch((e: Error) => e),
      m.getPortalStudentProfile(principal, kids.Asha, window).catch((e: Error) => e),
      m.getPortalStudentProfile(admin, kids.Asha, window).catch((e: Error) => e),
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(m.NotFoundError);
      expect((e as Error).message).toBe("Not found.");
    }
  });

  it("a block, an unlink and a soft delete apply at the next request", async () => {
    const parent = await user("parentC", "PARENT", { guardianId: guardians.Asha });
    const token = await tokenFor(parent.id);
    await m.prisma.studentGuardian.update({ where: { studentId_guardianId: { studentId: kids.Bina, guardianId: guardians.Asha } }, data: { portalAccess: false } });
    let ctx = (await m.validateSessionToken(token))!;
    await expect(m.getPortalStudentProfile(ctx, kids.Bina, window)).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.listPortalChildren(ctx, window)).map((k) => k.id)).toEqual([kids.Asha]);

    await m.prisma.studentGuardian.delete({ where: { studentId_guardianId: { studentId: kids.Bina, guardianId: guardians.Asha } } });
    ctx = (await m.validateSessionToken(token))!;
    expect(ctx.portal?.children.map((c) => c.studentId)).toEqual([kids.Asha]);

    const own = await admit("Chitra");
    const studentAccount = await user("stuC", "STUDENT", { studentId: own.studentId });
    const sToken = await tokenFor(studentAccount.id);
    expect((await m.validateSessionToken(sToken))!.portal?.studentId).toBe(own.studentId);
    await m.prisma.student.update({ where: { id: own.studentId }, data: { deletedAt: new Date() } });
    const after = (await m.validateSessionToken(sToken))!;
    expect(after.portal).toMatchObject({ kind: "STUDENT", studentId: null, children: [] });
  });

  it("mixed role sets are refused; a parent account can't be given a staff role", async () => {
    await expect(m.createUser(admin, { username: `${run}-mixed`, displayName: "Synthetic Mixed", email: null, roleKeys: ["PARENT", "TEACHER"] })).rejects.toBeInstanceOf(m.ValidationError);
    const parent = await user("parentD", "PARENT", { guardianId: guardians.Bina });
    await expect(m.updateUser(admin, { id: parent.id, displayName: "Synthetic parentD", email: null, roleKeys: ["PARENT", "TEACHER"] })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.updateUser(admin, { id: parent.id, displayName: "Synthetic parentD", email: null, roleKeys: ["TEACHER"] })).rejects.toBeInstanceOf(m.ValidationError);
    const roles = await m.prisma.userRole.findMany({ where: { userId: parent.id }, select: { role: { select: { key: true } } } });
    expect(roles.map((r) => r.role.key)).toEqual(["PARENT"]);
  });

  it("review M1: an account-kind change ends the sessions; /erp/users can't edit portal accounts; an old long staff session is bounded", async () => {
    const staffAcct = await user("staffF", "TEACHER");
    const { token } = await m.createSession(staffAcct.id, { long: true });
    await m.updateUser(admin, { id: staffAcct.id, displayName: "Synthetic staffF", email: null, roleKeys: ["PARENT"] });
    expect(await m.validateSessionToken(token)).toBeNull(); // revoked with the kind change (and no consent recorded)
    const parentAcct = await user("parentF", "PARENT");
    await expect(m.updateUser(admin, { id: parentAcct.id, displayName: "Synthetic parentF", email: `${run}@example.test`, roleKeys: ["PARENT"] })).rejects.toBeInstanceOf(m.ForbiddenError); // review 6A-M4 M1
    // A long session that a staff account still holds (issued under the old rule) is cut to 8 h at the next request.
    const acct = await user("teacherF", "TEACHER");
    const legacy = await m.createSession(acct.id, { long: true });
    const ctx = (await m.validateSessionToken(legacy.token))!;
    expect(ctx.portal).toBeNull();
    const row = await m.prisma.session.findUniqueOrThrow({ where: { id: legacy.sessionId }, select: { expiresAt: true, lastSeenAt: true } });
    expect(row.expiresAt.getTime() - row.lastSeenAt.getTime()).toBeLessThanOrEqual(m.STAFF_SESSION_MS);
  });

  it("'keep me signed in': 30 days for a parent, 8 hours for staff", async () => {
    const password = `Synthetic-${run}-pw!`;
    const parent = await user("parentE", "PARENT", { guardianId: guardians.Bina, password });
    const teacher = await user("teacherE", "TEACHER", { password });
    const meta = { ipHash: `ip-${run}` };
    const p = await m.login({ username: parent.username, password, remember: true }, meta);
    const t = await m.login({ username: teacher.username, password, remember: true }, meta);
    const hours = (d: Date) => (d.getTime() - Date.now()) / 3_600_000;
    expect(hours(p.expiresAt)).toBeGreaterThan(24 * 29);
    expect(p.home).toBe("/portal");
    expect(hours(t.expiresAt)).toBeLessThanOrEqual(8);
    expect(t.home).toBe("/erp");
  });
});
