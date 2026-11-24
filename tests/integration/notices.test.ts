import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6C-M1 — notices against the real database (PHASE_6_PLAN.md §6 6C-M1). PENDING until KI-059 (and migration
 * 20261127000000 on Test). Synthetic data only.
 * - a section notice is invisible to other sections' parents; a class notice reaches every section of the class;
 * - a class teacher writes only to their own section's families (ASSIGNED, open session) and can't see other notices;
 * - scheduled not visible early; withdrawn disappears; expired hidden; staff-only invisible to families and vice versa;
 * - never edited after publish; read receipts count each account once; the database CHECKs hold.
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
  ...(await import("@/modules/notices/notices.service")),
  ...(await import("@/modules/notices/notices.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("notices (integration)", () => {
  const run = `n6c${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2000 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, principal: Ctx, officer: Ctx, teacher: Ctx, accountant: Ctx, parentA: Ctx, parentA2: Ctx, parentB: Ctx;
  let sessionId: string, classId: string, sectionA: string, sectionB: string;
  const kid: Record<string, { studentId: string; guardianId: string }> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const window = { today: `${year}-10-15`, leaverAccessDays: 180 };
  let seq = 0;
  // The synthetic session (2000–2019) has ended, so notices carry an explicit "show until" (owner decision 2026-11-24:
  // without one a notice ends with its session — covered by its own case below).
  const text = { body: "Synthetic notice text.", publishAt: "", showUntil: "2099-12-31" };

  async function staff(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  async function parentOf(suffix: string, guardianId: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "PARENT" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", privacyConsentAt: new Date(), guardianId, roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string, sectionId: string, guardians = 1) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: "2015-05-01", gender: "FEMALE" });
    const g = (rel: "MOTHER" | "FATHER", primary: boolean) => ({ relation: rel, name: `Synthetic ${rel} ${firstName}`, phone: `107${String(Date.now() % 1e6).padStart(6, "0")}${seq++ % 10}`, altPhone: null, email: null, occupation: null, isPrimary: primary, isEmergencyContact: primary });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: guardians === 2 ? [g("MOTHER", true), g("FATHER", false)] : [g("MOTHER", true)] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-04-01`, duplicateOverride: null, guardianLinks: {} });
    const links = await m.prisma.studentGuardian.findMany({ where: { studentId }, orderBy: { isPrimary: "desc" }, select: { guardianId: true } });
    return { studentId, guardianId: links[0].guardianId, otherGuardianId: links[1]?.guardianId };
  }
  const versionOf = async (id: string) => (await m.prisma.notice.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function published(ctx: Ctx, input: { title: string; audience: "FAMILIES" | "STAFF" | "ALL"; scope: "SCHOOL" | "CLASS" | "SECTION"; targetIds: string[]; publishAt?: string }) {
    const { id } = await m.createNotice(ctx, { academicSessionId: sessionId, ...text, ...input, publishAt: input.publishAt ?? "" });
    await m.publishNotice(ctx, { id, version: await versionOf(id) });
    return id;
  }
  const familyTitles = async (ctx: Ctx) => (await m.listPortalNotices(ctx, window)).map((n) => n.title);
  const staffTitles = async (ctx: Ctx) => (await m.listStaffNotices(ctx)).map((n) => n.title);

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, principal, officer, teacher, accountant] = await Promise.all([staff("root", "SUPER_ADMIN"), staff("pr", "PRINCIPAL"), staff("ao", "ADMISSION_OFFICER"), staff("ct", "CLASS_TEACHER"), staff("ac", "ACCOUNTANT")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-N`, name: `${run} Class N`, numericLevel: 5, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    [sectionA, sectionB] = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A", "B"], capacity: 40 })).map((s) => s.id);
    // Fixture: the class teacher leads section A (the assignment service needs an employee record; not under test here).
    await m.prisma.section.update({ where: { id: sectionA }, data: { classTeacherId: teacher.userId } });
    teacher = (await m.validateSessionToken((await m.createSession(teacher.userId, { long: false })).token))!;
    const a = await admit("Asha", sectionA, 2);
    kid.A = a;
    kid.B = await admit("Bela", sectionB);
    parentA = await parentOf("pa", a.guardianId);
    parentA2 = await parentOf("pa2", a.otherGuardianId!);
    parentB = await parentOf("pb", kid.B.guardianId);
  }, 180_000);

  it("a section notice reaches that section's families only; a class notice every section of the class", async () => {
    await published(principal, { title: `${run} section A`, audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA] });
    await published(principal, { title: `${run} class`, audience: "FAMILIES", scope: "CLASS", targetIds: [classId] });
    await published(principal, { title: `${run} school`, audience: "ALL", scope: "SCHOOL", targetIds: [] });
    expect(await familyTitles(parentA)).toEqual(expect.arrayContaining([`${run} section A`, `${run} class`, `${run} school`]));
    const b = await familyTitles(parentB);
    expect(b).toEqual(expect.arrayContaining([`${run} class`, `${run} school`]));
    expect(b).not.toContain(`${run} section A`);
    const idA = (await m.prisma.notice.findFirstOrThrow({ where: { title: `${run} section A` } })).id;
    await expect(m.openPortalNotice(parentB, idA, window)).rejects.toThrow("Not found.");
    await expect(m.openPortalNotice(parentB, "c0000000000000000000000000", window)).rejects.toThrow("Not found.");
  });

  it("staff-only notices are invisible to families; family-only notices are invisible on the staff list", async () => {
    const staffOnly = await published(principal, { title: `${run} staff only`, audience: "STAFF", scope: "SCHOOL", targetIds: [] });
    const familyOnly = await published(principal, { title: `${run} families only`, audience: "FAMILIES", scope: "SCHOOL", targetIds: [] });
    expect(await familyTitles(parentA)).not.toContain(`${run} staff only`);
    await expect(m.openPortalNotice(parentA, staffOnly, window)).rejects.toThrow("Not found.");
    const s = await staffTitles(accountant);
    expect(s).toContain(`${run} staff only`);
    expect(s).toContain(`${run} school`); // ALL
    expect(s).not.toContain(`${run} families only`);
    await expect(m.openStaffNotice(accountant, familyOnly)).rejects.toBeInstanceOf(m.NotFoundError);
    // Families read only through the portal reads, staff only through the staff reads.
    await expect(m.listStaffNotices(parentA)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.listPortalNotices(accountant, window)).rejects.toBeInstanceOf(m.NotFoundError);
  });

  it("class teacher: own section's families only, in an open session; other notices are NotFound", async () => {
    const id = await published(teacher, { title: `${run} from the class teacher`, audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA] });
    expect(await familyTitles(parentA)).toContain(`${run} from the class teacher`);
    await expect(m.createNotice(teacher, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "SECTION", targetIds: [sectionB] })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.createNotice(teacher, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA, sectionB] })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.createNotice(teacher, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "SCHOOL", targetIds: [] })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.createNotice(teacher, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "CLASS", targetIds: [classId] })).rejects.toBeInstanceOf(m.ForbiddenError);
    const principals = (await m.prisma.notice.findFirstOrThrow({ where: { title: `${run} section A` } })).id;
    await expect(m.getManagedNotice(teacher, principals)).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.withdrawNotice(teacher, { id: principals, version: await versionOf(principals) })).rejects.toBeInstanceOf(m.NotFoundError);
    // Review 6C-M1 H1: a Principal's DRAFT to the teacher's own section is not the teacher's either.
    const { id: draft } = await m.createNotice(principal, { academicSessionId: sessionId, ...text, title: `${run} principal draft`, audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA] });
    for (const call of [() => m.getManagedNotice(teacher, draft), async () => m.updateNotice(teacher, { id: draft, version: await versionOf(draft), ...text, title: "x", audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA] }), async () => m.deleteNotice(teacher, { id: draft, version: await versionOf(draft) }), async () => m.publishNotice(teacher, { id: draft, version: await versionOf(draft) })]) {
      await expect(call()).rejects.toBeInstanceOf(m.NotFoundError);
    }
    expect((await m.listManagedNotices(teacher, sessionId)).map((n) => n.id)).toEqual([id]);
    // Moved off the section: the teacher loses the old notice; a closed session ends writing for everyone ASSIGNED.
    await m.prisma.section.update({ where: { id: sectionA }, data: { classTeacherId: null } });
    await expect(m.getManagedNotice(teacher, id)).rejects.toBeInstanceOf(m.NotFoundError);
    await m.prisma.section.update({ where: { id: sectionA }, data: { classTeacherId: teacher.userId } });
    expect((await m.getManagedNotice(teacher, id)).id).toBe(id);
    // Portal and other staff can't manage at all.
    await expect(m.createNotice(parentA, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "SCHOOL", targetIds: [] })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.createNotice(accountant, { academicSessionId: sessionId, ...text, title: "x", audience: "FAMILIES", scope: "SCHOOL", targetIds: [] })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("scheduled isn't visible early; withdrawn disappears; expired is hidden; never edited after publish", async () => {
    const later = await published(principal, { title: `${run} scheduled`, audience: "FAMILIES", scope: "SCHOOL", targetIds: [], publishAt: `${year + 50}-01-01T08:00` });
    expect((await m.getManagedNotice(principal, later)).state).toBe("SCHEDULED");
    expect(await familyTitles(parentA)).not.toContain(`${run} scheduled`);
    await expect(m.openPortalNotice(parentA, later, window)).rejects.toThrow("Not found.");

    const gone = await published(principal, { title: `${run} withdrawn`, audience: "FAMILIES", scope: "SCHOOL", targetIds: [] });
    expect(await familyTitles(parentA)).toContain(`${run} withdrawn`);
    await m.withdrawNotice(principal, { id: gone, version: await versionOf(gone) });
    expect(await familyTitles(parentA)).not.toContain(`${run} withdrawn`);
    await expect(m.openPortalNotice(parentA, gone, window)).rejects.toThrow("Not found.");

    const old = await published(principal, { title: `${run} expired`, audience: "FAMILIES", scope: "SCHOOL", targetIds: [] });
    await m.prisma.notice.update({ where: { id: old }, data: { publishAt: new Date(Date.now() - 3 * 86_400_000), expiresAt: new Date(Date.now() - 86_400_000) } });
    expect(await familyTitles(parentA)).not.toContain(`${run} expired`);

    // No "show until": the notice ends with its (long-closed) synthetic session.
    const { id: noEnd } = await m.createNotice(principal, { academicSessionId: sessionId, ...text, showUntil: "", title: `${run} session ended`, audience: "FAMILIES", scope: "SCHOOL", targetIds: [] });
    await m.publishNotice(principal, { id: noEnd, version: await versionOf(noEnd) });
    expect((await m.getManagedNotice(principal, noEnd)).state).toBe("EXPIRED");
    expect(await familyTitles(parentA)).not.toContain(`${run} session ended`);

    const v = await versionOf(old);
    await expect(m.updateNotice(principal, { id: old, version: v, ...text, title: "changed", audience: "FAMILIES", scope: "SCHOOL", targetIds: [] })).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.deleteNotice(principal, { id: old, version: v })).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.publishNotice(principal, { id: old, version: v })).rejects.toBeInstanceOf(m.ConflictError);
    await expect(m.withdrawNotice(principal, { id: old, version: v - 1 })).rejects.toBeInstanceOf(m.ConflictError); // stale version
  });

  it("drafts: editable (scope change replaces the targets), deletable, invisible to readers; audit without text", async () => {
    const { id } = await m.createNotice(principal, { academicSessionId: sessionId, ...text, title: `${run} draft`, audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA, sectionB] });
    expect(await familyTitles(parentA)).not.toContain(`${run} draft`);
    await m.updateNotice(principal, { id, version: await versionOf(id), ...text, title: `${run} draft`, audience: "FAMILIES", scope: "CLASS", targetIds: [classId] });
    const targets = await m.prisma.noticeTarget.findMany({ where: { noticeId: id }, select: { scope: true, classId: true, sectionId: true } });
    expect(targets).toEqual([{ scope: "CLASS", classId, sectionId: null }]);
    const rows = await m.prisma.auditLog.findMany({ where: { entityId: id }, select: { action: true, after: true, before: true } });
    expect(rows.map((r) => r.action).sort()).toEqual(["notice.create", "notice.update"]);
    expect(JSON.stringify(rows)).not.toMatch(/Synthetic notice text|draft/);
    await m.deleteNotice(principal, { id, version: await versionOf(id) });
    expect(await m.prisma.notice.count({ where: { id } })).toBe(0);
  });

  it("read receipts: each account once; the reach counts activated family accounts of the audience", async () => {
    const id = await published(principal, { title: `${run} receipts`, audience: "FAMILIES", scope: "SECTION", targetIds: [sectionA] });
    await m.openPortalNotice(parentA, id, window);
    await m.openPortalNotice(parentA, id, window);
    let r = (await m.getManagedNotice(principal, id)).receipts;
    expect(r).toMatchObject({ familyReads: 1, familyReach: 2, staffReads: 0 }); // two guardians of Asha; Bela's parent is in B
    await m.openPortalNotice(parentB, id, window).catch(() => null); // not in the audience: refused, nothing recorded
    await m.openPortalNotice(parentA2, id, window, { recordRead: false }); // opened from another site (L2): no receipt
    expect((await m.getManagedNotice(principal, id)).receipts.familyReads).toBe(1);
    await m.openPortalNotice(parentA2, id, window);
    r = (await m.getManagedNotice(principal, id)).receipts;
    expect(r.familyReads).toBe(2);
    expect((await m.listPortalNotices(parentA, window)).find((n) => n.id === id)?.read).toBe(true);
    // A blocked link (P24) leaves the audience at the next request.
    await m.prisma.studentGuardian.update({ where: { studentId_guardianId: { studentId: kid.A.studentId, guardianId: kid.A.guardianId } }, data: { portalAccess: false } });
    // Review 6C-M1 L1: reads are counted with the reach's own rule, so the blocked account leaves both (never > 100 %).
    expect((await m.getManagedNotice(principal, id)).receipts).toMatchObject({ familyReach: 1, familyReads: 1 });
    const fresh = (await m.validateSessionToken((await m.createSession(parentA.userId, { long: false })).token))!;
    await expect(m.openPortalNotice(fresh, id, window)).rejects.toThrow("Not found.");
    await m.prisma.studentGuardian.update({ where: { studentId_guardianId: { studentId: kid.A.studentId, guardianId: kid.A.guardianId } }, data: { portalAccess: true } });
  });

  it("the database refuses impossible rows (CHECKs, composite FKs)", async () => {
    const base = { academicSessionId: sessionId, title: "t", body: "b", createdById: principal.userId };
    await expect(m.prisma.notice.create({ data: { ...base, audience: "STAFF", scope: "SECTION" } })).rejects.toThrow();
    await expect(m.prisma.notice.create({ data: { ...base, audience: "FAMILIES", scope: "SCHOOL", status: "PUBLISHED" } })).rejects.toThrow(); // no publish times
    await expect(m.prisma.notice.create({ data: { ...base, audience: "FAMILIES", scope: "SCHOOL", title: "   " } })).rejects.toThrow();
    const n = await m.prisma.notice.create({ data: { ...base, audience: "FAMILIES", scope: "SECTION" } });
    await expect(m.prisma.noticeTarget.create({ data: { noticeId: n.id, academicSessionId: sessionId, scope: "CLASS", classId } })).rejects.toThrow(); // scope mismatch
    await expect(m.prisma.noticeTarget.create({ data: { noticeId: n.id, academicSessionId: sessionId, scope: "SECTION", classId } })).rejects.toThrow(); // kind CHECK
    const other = (await m.createAcademicSession(root, { name: `${year + 30}-${String((year + 31) % 100).padStart(2, "0")}`, startDate: `${year + 30}-04-01`, endDate: `${year + 31}-03-31` })).id;
    await expect(m.prisma.noticeTarget.create({ data: { noticeId: n.id, academicSessionId: other, scope: "SECTION", sectionId: sectionA } })).rejects.toThrow(); // other session
    await m.prisma.notice.delete({ where: { id: n.id } });
  });
});
