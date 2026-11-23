import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6A-M3a — parent portal accounts against the real database (PHASE_6_PLAN.md §6 6A-M3, §11). PENDING until
 * KI-059; skipped otherwise. Synthetic data only. Rate limits: each username stays under 20 activation attempts
 * (RULES.activationPerUser); every attempt uses a fresh client IP.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/auth/activation-code")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/identity/auth.service")),
  ...(await import("@/modules/identity/activation.service")),
  ...(await import("@/modules/identity/users.service")),
  ...(await import("@/modules/students/family-accounts.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("parent portal accounts (integration)", () => {
  const run = `pa${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, schoolAdmin: Ctx, principal: Ctx, officer: Ctx, teacher: Ctx;
  let sessionId: string, classId: string, sectionA: string, sectionB: string;
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const meta = { ipHash: `ip-${run}` };
  const password = `Synthetic-${run}-pw!`;
  let phoneSeq = 0;
  const phone = () => `9${String(Date.now() % 1e8).padStart(8, "0")}${phoneSeq++ % 10}`;

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, sectionId: string, dob = "2015-05-01", guardianPhone = phone()) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob, gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: `Synthetic Parent ${firstName}`, phone: guardianPhone, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    return { studentId, guardianId, dob, phone: guardianPhone };
  }
  const plain = (code: string) => code.replace(/-/g, "");
  // A fresh client IP per attempt: the per-IP limit (10 / h) would otherwise be shared by the whole suite.
  let ipSeq = 0;
  const activate = (username: string, code: string, dob: string, pw = password) => m.activateFamilyAccount({ username, code, dob, consent: true, newPassword: pw, confirmPassword: pw }, { ipHash: `ip-${run}-${ipSeq++}` });

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, schoolAdmin, principal, officer, teacher] = await Promise.all([user("root", "SUPER_ADMIN"), user("sa", "SCHOOL_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER"), user("t", "TEACHER")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-F`, name: `${run} Class F`, numericLevel: 5, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    [sectionA, sectionB] = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A", "B"], capacity: 40 })).map((s) => s.id);
  }, 120_000);

  it("a slip creates a PARENT account with no usable password; code + DOB + consent activate it", async () => {
    const kid = await admit("Asha", sectionA, "2015-04-01");
    const [slip] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null });
    expect(slip).toMatchObject({ username: kid.phone, children: [expect.stringContaining("Asha")] });
    const acct = await m.prisma.user.findFirstOrThrow({ where: { guardianId: kid.guardianId }, select: { id: true, passwordHash: true, privacyConsentAt: true, roles: { select: { role: { select: { key: true } } } } } });
    expect(acct.roles.map((r) => r.role.key)).toEqual(["PARENT"]);
    expect(m.isUsablePasswordHash(acct.passwordHash)).toBe(false);
    await expect(m.login({ username: kid.phone, password: "anything-at-all", remember: false }, meta)).rejects.toBeInstanceOf(m.InvalidCredentialsError);

    const session = await activate(kid.phone, slip.code.toLowerCase(), kid.dob);
    const ctx = (await m.validateSessionToken(session.token))!;
    expect(ctx.portal?.children.map((c) => c.studentId)).toEqual([kid.studentId]);
    const after = await m.prisma.user.findUniqueOrThrow({ where: { id: acct.id }, select: { privacyConsentAt: true, privacyConsentVersion: true } });
    expect(after.privacyConsentAt).not.toBeNull();
    expect(after.privacyConsentVersion).toBeTruthy();
    // Single use.
    await expect(activate(kid.phone, slip.code, kid.dob)).rejects.toBeInstanceOf(m.ActivationFailedError);
    // Audit: no code, no date of birth, no password.
    const rows = await m.prisma.auditLog.findMany({ where: { entityId: acct.id }, select: { before: true, after: true } });
    expect(JSON.stringify(rows)).not.toMatch(new RegExp(`${plain(slip.code)}|${slip.code}|${kid.dob}|${password}`));
  });

  it("wrong code, wrong DOB, superseded and unknown username all give the same error; wrong codes don't count, 5 wrong DOBs void the code", async () => {
    const kid = await admit("Bina", sectionA, "2015-06-02");
    const [first] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null });
    const [second] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "reset", username: null });
    const errs = await Promise.all([
      activate(kid.phone, first.code, kid.dob).catch((e: Error) => e), // superseded
      activate(kid.phone, second.code, "2015-06-03").catch((e: Error) => e), // DOB mismatch
      activate(`${run}-nobody`, second.code, kid.dob).catch((e: Error) => e), // unknown username
      activate(kid.phone, "ZZZZ-ZZZZ-ZZZZ", kid.dob).catch((e: Error) => e), // wrong code
    ]);
    for (const e of errs) {
      expect(e).toBeInstanceOf(m.ActivationFailedError);
      expect((e as Error).message).toBe(new m.ActivationFailedError().message);
    }
    const row = () => m.prisma.accountActivation.findFirstOrThrow({ where: { codeHash: m.hashActivationCode(plain(second.code)) }, select: { usedAt: true, failedAttempts: true } });
    // Review M1: junk codes from someone who only knows the mobile number never void the parent's slip.
    for (let i = 0; i < 6; i++) await expect(activate(kid.phone, "ZZZZ-ZZZZ-ZZZZ", kid.dob)).rejects.toBeInstanceOf(m.ActivationFailedError);
    expect(await row()).toMatchObject({ usedAt: null, failedAttempts: 1 }); // only the DOB mismatch above counted
    for (let i = 0; i < 4; i++) await expect(activate(kid.phone, second.code, "2015-01-01")).rejects.toBeInstanceOf(m.ActivationFailedError);
    const voided = await row();
    expect(voided.failedAttempts).toBe(5);
    expect(voided.usedAt).not.toBeNull();
    await expect(activate(kid.phone, second.code, kid.dob)).rejects.toBeInstanceOf(m.ActivationFailedError);
  });

  it("two activations of the same code at once: exactly one wins", async () => {
    const kid = await admit("Chitra", sectionA, "2015-07-03");
    const [slip] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null });
    const results = await Promise.allSettled([activate(kid.phone, slip.code, kid.dob), activate(kid.phone, slip.code, kid.dob, `${password}-2`)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("a section run is idempotent: siblings share one slip; a second run prints nothing; reissue only for pending", async () => {
    const sharedPhone = phone();
    const s1 = await admit("Devi", sectionB, "2014-01-01", sharedPhone);
    const s2 = await admit("Esha", sectionB, "2016-01-01");
    // Esha's primary guardian becomes Devi's guardian too → siblings.
    await m.prisma.studentGuardian.deleteMany({ where: { studentId: s2.studentId } });
    await m.prisma.studentGuardian.create({ data: { studentId: s2.studentId, guardianId: s1.guardianId, relation: "MOTHER", isPrimary: true } });
    const s3 = await admit("Farah", sectionB, "2015-02-02");
    const first = await m.issueSectionSlips(schoolAdmin, { sectionId: sectionB, reissuePending: false });
    expect(first.slips.map((s) => s.username).sort()).toEqual([sharedPhone, s3.phone].sort());
    expect(first.slips.find((s) => s.username === sharedPhone)?.children).toHaveLength(2);
    expect((await m.issueSectionSlips(schoolAdmin, { sectionId: sectionB, reissuePending: false })).slips).toEqual([]);
    expect(await m.prisma.user.count({ where: { guardianId: { in: [s1.guardianId, s3.guardianId] } } })).toBe(2);
    await activate(s3.phone, first.slips.find((s) => s.username === s3.phone)!.code, s3.dob);
    const again = await m.issueSectionSlips(schoolAdmin, { sectionId: sectionB, reissuePending: true });
    expect(again.slips.map((s) => s.username)).toEqual([sharedPhone]); // the activated account is untouched
    // Either sibling's date of birth proves the shared account.
    await activate(sharedPhone, again.slips[0].code, s2.dob);
  });

  it("a taken username is refused without saying whose; the office then chooses one", async () => {
    const kid = await admit("Gita", sectionA);
    await m.prisma.user.create({ data: { username: kid.phone, displayName: "Synthetic Holder", passwordHash: "x" } });
    const err = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(m.ValidationError);
    expect((err as Error).message).not.toMatch(/Synthetic Holder/);
    const [slip] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: `${run}-gita` });
    expect(slip.username).toBe(`${run}-gita`);
  });

  it("office reset: the old password stops working and sessions end; deactivation blocks login; a blocked link hides the child", async () => {
    const kid = await admit("Hema", sectionA, "2015-08-04");
    const [slip] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null });
    const session = await activate(kid.phone, slip.code, kid.dob);
    await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "reset", username: null });
    expect(await m.validateSessionToken(session.token)).toBeNull();
    await expect(m.login({ username: kid.phone, password, remember: false }, meta)).rejects.toBeInstanceOf(m.InvalidCredentialsError);

    await m.setFamilyAccountActive(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, active: false, reason: "Synthetic test" });
    await expect(m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "reset", username: null })).rejects.toBeInstanceOf(m.ConflictError);
    await m.setFamilyAccountActive(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, active: true, reason: "Synthetic test" });
    const [fresh] = await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "reset", username: null });
    const s2 = await activate(kid.phone, fresh.code, kid.dob);
    await m.setGuardianPortalAccess(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, portalAccess: false });
    expect((await m.validateSessionToken(s2.token))!.portal?.children[0]?.portalAccess).toBe(false);
  });

  it("review: /erp/users can't reset or switch a portal account; a blocked guardian gets no slip", async () => {
    const kid = await admit("Jaya", sectionA);
    await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null });
    const acct = await m.prisma.user.findFirstOrThrow({ where: { guardianId: kid.guardianId }, select: { id: true } });
    await expect(m.adminResetPassword(root, acct.id)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.setUserActive(root, acct.id, false)).rejects.toBeInstanceOf(m.ForbiddenError);
    const other = await admit("Kala", sectionA);
    await m.setGuardianPortalAccess(schoolAdmin, { studentId: other.studentId, guardianId: other.guardianId, portalAccess: false });
    await expect(m.issueGuardianSlip(schoolAdmin, { studentId: other.studentId, guardianId: other.guardianId, mode: "create", username: null })).rejects.toBeInstanceOf(m.ValidationError);
    expect(await m.prisma.user.count({ where: { guardianId: other.guardianId } })).toBe(0);
  });

  it("roles without portal.account.manage are refused; an edited PARENT role stops provisioning", async () => {
    const kid = await admit("Indu", sectionA);
    for (const ctx of [teacher, principal, officer]) {
      await expect(m.issueGuardianSlip(ctx, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null })).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.getFamilyAccess(ctx, kid.studentId)).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    const parentRole = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" }, select: { id: true } });
    const perm = await m.prisma.permission.findUniqueOrThrow({ where: { key: "employee.read" }, select: { id: true } });
    await m.prisma.rolePermission.create({ data: { roleId: parentRole.id, permissionId: perm.id, scope: "ALL" } });
    try {
      await expect(m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "create", username: null })).rejects.toBeInstanceOf(m.ForbiddenError);
    } finally {
      await m.prisma.rolePermission.deleteMany({ where: { roleId: parentRole.id, permissionId: perm.id } });
    }
  });
});
