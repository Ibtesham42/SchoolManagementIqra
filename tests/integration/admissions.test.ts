import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until migrations 20261110000000 + 20261111000000 are applied to the Neon "test" branch and
 * TEST_DATABASE_URL is configured (separate owner approval) — skipped otherwise (KI-043: only via
 * `npm run test:integration`). Phase 2B S3: admission drafts, submission numbering, duplicates, review
 * actions, RBAC and audit — real transactions and row locks. Synthetic data only; removed in afterAll.
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
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("admission applications (integration)", () => {
  const run = `ad${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const baseYear = 2200 + Math.floor(Math.random() * 600);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, officer: Ctx, principal: Ctx, teacher: Ctx, accountant: Ctx, parent: Ctx;
  let sessionId: string, sessionName: string, classId: string, sectionId: string;
  const sessionIds: string[] = [];
  const classIds: string[] = [];

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const draftInput = (over: Record<string, unknown> = {}) => ({
    academicSessionId: sessionId, classId, firstName: "Synthetic", middleName: null, lastName: `Child${Math.random().toString(36).slice(2, 7)}`, dob: "2019-05-01", gender: "FEMALE" as const, ...over,
  });
  const guardians = (phone = "9876500001") => [{ relation: "MOTHER" as const, name: "Synthetic Parent", phone, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }];
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const version = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;

  /** A complete draft (steps 1–3) ready to submit. */
  async function readyDraft(ctx: Ctx, over: Record<string, unknown> = {}, phone?: string) {
    const { id } = await m.createDraft(ctx, draftInput(over));
    await m.updateGuardiansStep(ctx, { id, version: await version(id), guardians: guardians(phone) });
    await m.updateContactStep(ctx, { id, version: await version(id), phone: null, email: null, address });
    return id;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    // Principal's admission.approve is an existing permission: on an existing database the seed doesn't add it
    // (design §4.1); the integration catalog setup seeds every catalog role exactly, so it is present here.
    const [root, ao, pr, t, acc, par] = await Promise.all([
      user("root", "SUPER_ADMIN"), user("ao", "ADMISSION_OFFICER"), user("pr", "PRINCIPAL"), user("t", "TEACHER"), user("acc", "ACCOUNTANT"), user("par", "PARENT"),
    ]);
    [admin, officer, principal, teacher, accountant, parent] = await Promise.all([ctxFor(root.id), ctxFor(ao.id), ctxFor(pr.id), ctxFor(t.id), ctxFor(acc.id), ctxFor(par.id)]);
    sessionName = `${baseYear}-${String((baseYear + 1) % 100).padStart(2, "0")}`;
    const s = await m.createAcademicSession(admin, { name: sessionName, startDate: `${baseYear}-04-01`, endDate: `${baseYear + 1}-03-31` });
    sessionId = s.id;
    sessionIds.push(s.id);
    const c = (await m.createClass(admin, { code: `${tag}-1`, name: `${run} Class 1`, numericLevel: 1, displayOrder: 0, defaultSectionCapacity: null }))!;
    classId = c.id;
    classIds.push(c.id);
    sectionId = (await m.createSectionsBulk(admin, { academicSessionId: sessionId, classId, names: ["A"], capacity: 30 }))[0].id;
  });

  afterAll(async () => {
    const { prisma } = m;
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: { in: sessionIds } } });
    if (sessionName) await prisma.sequenceCounter.deleteMany({ where: { key: `application_no:${sessionName}` } });
    await prisma.section.deleteMany({ where: { academicSessionId: { in: sessionIds } } });
    await prisma.schoolClass.deleteMany({ where: { id: { in: classIds } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  });

  it("draft → submit assigns APP-<session>-<seq>; review → section → reject; every step audited without personal values", async () => {
    const id = await readyDraft(officer);
    const r = await m.submitApplication(officer, id, await version(id));
    expect(r.applicationNo).toMatch(new RegExp(`^APP-${sessionName}-\\d{4,}$`));
    await m.startReview(principal, id, await version(id));
    await m.setSection(principal, id, await version(id), sectionId);
    await m.rejectApplication(principal, id, await version(id), "Synthetic rejection reason");
    const row = await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.sectionId, row.rejectionReason, row.studentId]).toEqual(["REJECTED", sectionId, "Synthetic rejection reason", null]);
    const logs = await m.prisma.auditLog.findMany({ where: { entityType: "AdmissionApplication", entityId: id }, select: { action: true, before: true, after: true } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["admission.create", "admission.update", "admission.submit", "admission.review_start", "admission.section_set", "admission.reject"]));
    const text = JSON.stringify(logs);
    for (const pii of ["Synthetic Parent", "9876500001", "1 Example Road", row.lastName!]) expect(text).not.toContain(pii);
  });

  it("concurrent submissions get distinct, consecutive numbers; a rolled-back submit consumes none", async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => readyDraft(officer)));
    const before = (await m.prisma.sequenceCounter.findUnique({ where: { key: `application_no:${sessionName}` } }))?.value ?? 0;
    const versions = await Promise.all(ids.map(version));
    const results = await Promise.all(ids.map((id, i) => m.submitApplication(officer, id, versions[i])));
    const nums = results.map((x) => Number(x.applicationNo.split("-").pop())).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(5);
    expect(nums).toEqual(Array.from({ length: 5 }, (_, i) => before + 1 + i));
    // An incomplete draft fails validation inside the transaction → the counter is unchanged.
    const { id: bad } = await m.createDraft(officer, draftInput());
    await expect(m.submitApplication(officer, bad, await version(bad))).rejects.toBeInstanceOf(m.ValidationError);
    expect((await m.prisma.sequenceCounter.findUniqueOrThrow({ where: { key: `application_no:${sessionName}` } })).value).toBe(before + 5);
  });

  it("duplicate detection: same name + date of birth flagged; a shared guardian phone makes it strong", async () => {
    const same = { firstName: "Dup", lastName: `Twin${tag}`, dob: "2018-03-03" };
    const a = await readyDraft(officer, same, "9876500111");
    await m.submitApplication(officer, a, await version(a));
    const b = await readyDraft(officer, same, "9876500111");
    expect((await m.submitApplication(officer, b, await version(b))).duplicates).toBe(1);
    const detail = await m.getApplication(admin, b);
    expect(detail.duplicates).toEqual([expect.objectContaining({ kind: "application", id: a, strength: "strong" })]);
  });

  it("only drafts are editable; stale versions and closed sessions are refused; returned drafts keep their number", async () => {
    const id = await readyDraft(officer);
    const v = await version(id);
    await expect(m.updateContactStep(officer, { id, version: v + 7, phone: null, email: null, address })).rejects.toThrow(/changed by someone else/);
    const { applicationNo } = await m.submitApplication(officer, id, v);
    await expect(m.updateContactStep(officer, { id, version: await version(id), phone: null, email: null, address })).rejects.toBeInstanceOf(m.ConflictError);
    await m.returnToDraft(admin, id, await version(id), "Correct the address");
    const row = await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.applicationNo]).toEqual(["DRAFT", applicationNo]);
    await expect(m.deleteDraft(officer, id, row.version)).rejects.toThrow(/Reject it instead/);
  });

  it("RBAC: Admission Officer prepares but can't review; Teacher, Accountant and Parent get 403 everywhere", async () => {
    const id = await readyDraft(officer);
    await m.submitApplication(officer, id, await version(id));
    const v = await version(id);
    for (const call of [() => m.startReview(officer, id, v), () => m.setSection(officer, id, v, sectionId), () => m.rejectApplication(officer, id, v, "nope"), () => m.returnToDraft(officer, id, v, "nope")]) {
      await expect(call()).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    for (const ctx of [teacher, accountant, parent]) {
      for (const call of [
        () => m.listApplications(ctx, { page: 1, pageSize: 20 }),
        () => m.getApplication(ctx, id),
        () => m.createDraft(ctx, draftInput()),
        () => m.submitApplication(ctx, id, v),
        () => m.startReview(ctx, id, v),
        () => m.rejectApplication(ctx, id, v, "nope"),
        () => m.admissionFormOptions(ctx),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(m.ForbiddenError);
      }
    }
    await m.startReview(principal, id, v); // Principal approves/reviews (D2)
  });
});
