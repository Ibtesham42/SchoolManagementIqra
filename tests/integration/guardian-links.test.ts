import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { FIXTURE_DOB, freeFixtureYear } from "./fixture-year";

/**
 * Phase 6A-M3b — email invitations and guardian link / merge against the real database. PENDING until KI-059;
 * skipped otherwise. Synthetic data only. Email uses the default "log" provider (preview file in tmp/outbox).
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
  ...(await import("@/modules/students/family-accounts.service")),
  ...(await import("@/modules/students/guardian-links.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);
const FIXTURE_YEAR = enabled ? await freeFixtureYear(m.prisma, 1) : 2000;

describe.skipIf(!enabled)("guardian links and invitations (integration)", () => {
  const run = `gl${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = FIXTURE_YEAR; // a free past year on Test (fixture-year.ts)
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, schoolAdmin: Ctx, principal: Ctx, officer: Ctx, accountant: Ctx;
  let sessionId: string, classId: string, sectionId: string;
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  let seq = 0;
  const phone = () => `101${String(Date.now() % 1e6).padStart(6, "0")}${seq++ % 10}`; // "10x…": never a real Indian number

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, guardianPhone: string, email: string | null = null) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: FIXTURE_DOB, gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: `Synthetic Parent ${firstName}`, phone: guardianPhone, altPhone: null, email, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-06-01`, duplicateOverride: null, guardianLinks: {} });
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    return { studentId, guardianId };
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, schoolAdmin, principal, officer, accountant] = await Promise.all([user("root", "SUPER_ADMIN"), user("sa", "SCHOOL_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER"), user("acc", "ACCOUNTANT")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-G`, name: `${run} Class G`, numericLevel: 4, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    sectionId = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A"], capacity: 40 }))[0].id;
  }, 120_000);

  it("an email invitation creates the account and an EMAIL code; an account activated before is never re-opened by email", async () => {
    const kid = await admit("Lata", phone(), `${run}.lata@example.test`);
    const r = await m.sendFamilyInvitation(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, username: null });
    expect(r.sent).toBe(true);
    expect(r.to).toMatch(/^.\*\*\*@example\.test$/);
    const acct = await m.prisma.user.findFirstOrThrow({ where: { guardianId: kid.guardianId }, select: { id: true } });
    expect(await m.prisma.accountActivation.count({ where: { userId: acct.id, channel: "EMAIL", usedAt: null } })).toBe(1);
    // Simulate a completed activation, then an office reset: "ever activated" still blocks email (review M1).
    await m.prisma.user.update({ where: { id: acct.id }, data: { privacyConsentAt: new Date(), privacyConsentVersion: "1", passwordChangedAt: new Date() } });
    await expect(m.sendFamilyInvitation(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, username: null })).rejects.toBeInstanceOf(m.ConflictError);
    await m.issueGuardianSlip(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, mode: "reset", username: null });
    await expect(m.sendFamilyInvitation(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, username: null })).rejects.toBeInstanceOf(m.ConflictError);
    const noEmail = await admit("Mina", phone());
    await expect(m.sendFamilyInvitation(schoolAdmin, { studentId: noEmail.studentId, guardianId: noEmail.guardianId, username: null })).rejects.toBeInstanceOf(m.ValidationError);
  });

  it("review M2: an email changed by someone else in the last 7 days blocks the invitation until the office saves it itself", async () => {
    const kid = await admit("Neha", phone(), `${run}.neha@example.test`);
    await m.prisma.auditLog.create({ data: { actorId: principal.userId, action: "guardian.update", entityType: "Guardian", entityId: kid.guardianId, after: { studentId: kid.studentId, fields: ["email"] } } });
    await expect(m.sendFamilyInvitation(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, username: null })).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.auditLog.create({ data: { actorId: schoolAdmin.userId, action: "guardian.update", entityType: "Guardian", entityId: kid.guardianId, after: { studentId: kid.studentId, fields: ["email"] } } });
    // Once the office saves the confirmed address itself (the latest change is its own), the invitation goes out.
    expect((await m.sendFamilyInvitation(schoolAdmin, { studentId: kid.studentId, guardianId: kid.guardianId, username: null })).sent).toBe(true);
  });

  it("link an existing guardian (same mobile number only); a block on the student makes the new link start blocked", async () => {
    const shared = phone();
    const a = await admit("Nisha", shared);
    const b = await admit("Ojas", shared); // the same parent recorded again at the sibling's admission
    const found = await m.findGuardiansByPhone(schoolAdmin, { studentId: b.studentId, phone: shared });
    expect(found.map((g) => g.id)).toContain(a.guardianId);
    expect(found.every((g) => !("phone" in g))).toBe(true); // only the last 4 digits are echoed (review L6)
    expect(await m.linkGuardianToStudent(schoolAdmin, { studentId: b.studentId, guardianId: a.guardianId, relation: "MOTHER" })).toEqual({ portalAccess: true });
    await expect(m.linkGuardianToStudent(schoolAdmin, { studentId: b.studentId, guardianId: a.guardianId, relation: "MOTHER" })).rejects.toBeInstanceOf(m.ConflictError);
    // A stranger (different number) can't be linked, even by a crafted request (review H1).
    const stranger = await admit("Pooja", phone());
    await expect(m.linkGuardianToStudent(schoolAdmin, { studentId: b.studentId, guardianId: stranger.guardianId, relation: "OTHER" })).rejects.toBeInstanceOf(m.ValidationError);
    // Custody block: c's own guardian is blocked; linking the duplicate record of that parent starts blocked.
    const c = await admit("Qadira", shared);
    await m.setGuardianPortalAccess(schoolAdmin, { studentId: c.studentId, guardianId: c.guardianId, portalAccess: false });
    expect(await m.linkGuardianToStudent(schoolAdmin, { studentId: c.studentId, guardianId: a.guardianId, relation: "MOTHER" })).toEqual({ portalAccess: false });
  });

  it("merge: links move, a block is kept, the removed record is soft-deleted; different names need confirmation", async () => {
    const shared = phone();
    const first = await admit("Priya", shared);
    const second = await admit("Ravi", shared); // the same parent recorded again (different synthetic names)
    await m.prisma.studentGuardian.update({ where: { studentId_guardianId: { studentId: second.studentId, guardianId: second.guardianId } }, data: { portalAccess: false } });
    const input = { studentId: first.studentId, keepGuardianId: first.guardianId, removeGuardianId: second.guardianId };
    await expect(m.mergeGuardians(schoolAdmin, { ...input, confirmDifferent: false })).rejects.toBeInstanceOf(m.ValidationError);
    const r = await m.mergeGuardians(schoolAdmin, { ...input, confirmDifferent: true });
    expect(r.movedLinks).toBe(1);
    const links = await m.prisma.studentGuardian.findMany({ where: { guardianId: first.guardianId }, select: { studentId: true, isPrimary: true, portalAccess: true } });
    expect(links.find((l) => l.studentId === second.studentId)).toMatchObject({ isPrimary: true, portalAccess: false });
    expect((await m.prisma.guardian.findUniqueOrThrow({ where: { id: second.guardianId }, select: { deletedAt: true } })).deletedAt).not.toBeNull();
    expect(await m.prisma.studentGuardian.count({ where: { guardianId: second.guardianId } })).toBe(0);
    const row = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "guardian.merge", entityId: first.guardianId }, select: { after: true } });
    expect(JSON.stringify(row.after)).not.toMatch(new RegExp(shared));
    expect(row.after).toMatchObject({ confirmedDifferent: true, keptHasAccount: false });
  });

  it("merge works when a linked student was soft-deleted (review M3)", async () => {
    const shared = phone();
    const a = await admit("Ruhi", shared);
    const gone = await admit("Sana", shared);
    await m.prisma.student.update({ where: { id: gone.studentId }, data: { deletedAt: new Date() } });
    const r = await m.mergeGuardians(schoolAdmin, { studentId: a.studentId, keepGuardianId: a.guardianId, removeGuardianId: gone.guardianId, confirmDifferent: true });
    expect(r.movedLinks).toBe(1);
  });

  it("merge refusals: different numbers, removing the record with the account, same record; other roles 403", async () => {
    const x = await admit("Sita", phone());
    const y = await admit("Tara", phone());
    await expect(m.mergeGuardians(schoolAdmin, { studentId: x.studentId, keepGuardianId: x.guardianId, removeGuardianId: y.guardianId, confirmDifferent: true })).rejects.toBeInstanceOf(m.ValidationError);
    const shared = phone();
    const p = await admit("Uma", shared);
    const q = await admit("Vani", shared);
    await m.issueGuardianSlip(schoolAdmin, { studentId: q.studentId, guardianId: q.guardianId, mode: "create", username: `${run}-vani` });
    await expect(m.mergeGuardians(schoolAdmin, { studentId: p.studentId, keepGuardianId: p.guardianId, removeGuardianId: q.guardianId, confirmDifferent: true })).rejects.toBeInstanceOf(m.ConflictError);
    await m.mergeGuardians(schoolAdmin, { studentId: p.studentId, keepGuardianId: q.guardianId, removeGuardianId: p.guardianId, confirmDifferent: true }); // the other way round works
    await expect(m.mergeGuardians(schoolAdmin, { studentId: p.studentId, keepGuardianId: q.guardianId, removeGuardianId: q.guardianId, confirmDifferent: true })).rejects.toBeInstanceOf(m.ValidationError);
    for (const ctx of [principal, accountant, officer]) {
      await expect(m.findGuardiansByPhone(ctx, { studentId: p.studentId, phone: shared })).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.mergeGuardians(ctx, { studentId: x.studentId, keepGuardianId: x.guardianId, removeGuardianId: y.guardianId, confirmDifferent: true })).rejects.toBeInstanceOf(m.ForbiddenError);
    }
  });
});
