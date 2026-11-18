import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until migrations 20261110000000 + 20261111000000 are applied to the Neon "test" branch and
 * TEST_DATABASE_URL is configured (separate owner approval); skipped otherwise (KI-043). Phase 2B S5:
 * approval = registration — permanent IDs, guardians, enrollment, capacity, concurrency, rollback, audit.
 *
 * D11: the concurrency tests assert CORRECTNESS (unique IDs, exact capacity, no partial data, clean
 * "busy"/"full" outcomes). They do NOT claim that every one of many simultaneous approvals succeeds on the
 * default 5-connection pool — busy outcomes are allowed and then retried.
 *
 * KI-010 timing (measured 2026-11-10 against the Neon Test branch from the development machine: ~99 ms per
 * round trip; preparing one application ≈ 6 s sequentially; approvals into ONE section serialize on the
 * section row lock and the ID counters by design, ≈ 3.5 s each): the 50-application fixture is prepared in
 * its own hook with its own budget, and the concurrency test gets 10 minutes (50 × 3.5 s serialized ≈ 3 min
 * plus busy retries). Every approval and the fixture are tracked, and afterAll waits for them to settle, so
 * a timed-out test can't leave work running into later tests or past cleanup. Cleanup is session-scoped.
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

describe.skipIf(!enabled)("admission approval = student registration (integration)", () => {
  const run = `ap${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2200 + Math.floor(Math.random() * 600);
  const sessionName = `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, principal: Ctx, officer: Ctx, teacher: Ctx;
  let sessionId: string, classId: string;
  const admissionDate = `${year}-06-15`;
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
  async function section(name: string, capacity: number) {
    return (await m.createSectionsBulk(admin, { academicSessionId: sessionId, classId, names: [name], capacity }))[0].id;
  }
  /** A submitted application with a section set, ready for approval. */
  async function ready(sectionId: string, opts: { phone?: string; lastName?: string; dob?: string } = {}) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName: "Synthetic", middleName: null, lastName: opts.lastName ?? `K${Math.random().toString(36).slice(2, 8)}`, dob: opts.dob ?? "2019-05-01", gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await version(id), guardians: [{ relation: "MOTHER", name: "Synthetic Parent", phone: opts.phone ?? `98${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await version(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await version(id));
    await m.setSection(principal, id, await version(id), sectionId);
    return id;
  }
  /** Every approval and fixture promise started by this suite; afterAll waits for all of them to settle. */
  const inflight = new Set<Promise<unknown>>();
  const track = <T,>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    p.then(() => inflight.delete(p), () => inflight.delete(p));
    return p;
  };
  const approve = (ctx: Ctx, id: string, over: Partial<Parameters<typeof m.approveApplication>[1]> = {}) =>
    track((async () => m.approveApplication(ctx, { id, version: await version(id), admissionDate, duplicateOverride: null, guardianLinks: {}, ...over }))());
  const counter = async (base: string) => (await m.prisma.sequenceCounter.findUnique({ where: { key: `${base}:${year}` } }))?.value ?? 0;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, pr, ao, t] = await Promise.all([user("root", "SUPER_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER"), user("t", "TEACHER")]);
    [admin, principal, officer, teacher] = await Promise.all([ctxFor(root.id), ctxFor(pr.id), ctxFor(ao.id), ctxFor(t.id)]);
    sessionId = (await m.createAcademicSession(admin, { name: sessionName, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(admin, sessionId, "ACTIVE");
    classId = (await m.createClass(admin, { code: `${tag}-R`, name: `${run} Class R`, numericLevel: 3, displayOrder: 0, defaultSectionCapacity: null }))!.id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    // Late work first: a timed-out test's approvals (or the fixture) may still be running. Loop because a
    // settling promise can't start new tracked work after this point, but one may have been added meanwhile.
    while (inflight.size) await Promise.allSettled([...inflight]);
    if (!sessionId) return void (await prisma.user.deleteMany({ where: { username: { startsWith: run } } }), await prisma.$disconnect());
    // Session-scoped (never a list collected earlier): everything registered into this run's session.
    const students = await prisma.student.findMany({ where: { admittedSessionId: sessionId }, select: { id: true } });
    const studentIds = students.map((x) => x.id);
    const links = await prisma.studentGuardian.findMany({ where: { studentId: { in: studentIds } }, select: { guardianId: true } });
    const guardianIds = [...new Set(links.map((l) => l.guardianId))];
    await prisma.admissionApplication.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.student.deleteMany({ where: { admittedSessionId: sessionId } });
    // Only guardians no longer linked to anyone (all of this run's guardians are synthetic and run-local).
    await prisma.guardian.deleteMany({ where: { id: { in: guardianIds }, students: { none: {} }, applicantLinks: { none: {} } } });
    await prisma.sequenceCounter.deleteMany({ where: { key: { in: [`student_id:${year}`, `admission_no:${year}`, `application_no:${sessionName}`] } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 900_000);

  it("approval registers exactly one student with permanent IDs, guardian, enrollment and audit (no personal values)", async () => {
    const sec = await section("A", 40);
    const id = await ready(sec, { lastName: "Registerone" });
    const r = await approve(principal, id);
    expect(r.studentCode).toMatch(new RegExp(`-${year}-\\d{4,}$`)); // D4: session start year
    expect(r.admissionNo).toMatch(new RegExp(`-${year}-\\d{4,}$`));
    const student = await m.prisma.student.findUniqueOrThrow({ where: { id: r.studentId }, include: { guardians: true, enrollments: true } });
    expect([student.studentCode, student.admissionNo, student.status, student.guardians.length, student.enrollments.length]).toEqual([r.studentCode, r.admissionNo, "ACTIVE", 1, 1]);
    expect([student.enrollments[0].sectionId, student.enrollments[0].status, student.enrollments[0].enrolledOn.toISOString().slice(0, 10)]).toEqual([sec, "ACTIVE", admissionDate]);
    const app = await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id } });
    expect([app.status, app.studentId, app.decidedById]).toEqual(["APPROVED", r.studentId, principal.userId]);
    const logs = await m.prisma.auditLog.findMany({ where: { OR: [{ entityId: id }, { entityId: r.studentId }, { entityType: "StudentEnrollment", entityId: student.enrollments[0].id }] }, select: { action: true, after: true } });
    expect(logs.map((l) => l.action)).toEqual(expect.arrayContaining(["admission.approve", "student.create", "enrollment.create"]));
    const text = JSON.stringify(logs);
    for (const pii of ["Registerone", "Synthetic Parent", "1 Example Road"]) expect(text).not.toContain(pii);
    // A second approval of the same application is refused (it is final now).
    await expect(approve(principal, id)).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("two simultaneous approvals of the same application → one student, one enrollment", async () => {
    const sec = await section("B", 40);
    const id = await ready(sec);
    const v = await version(id);
    const results = await Promise.allSettled([0, 1].map(() => m.approveApplication(principal, { id, version: v, admissionDate, duplicateOverride: null, guardianLinks: {} })));
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(m.ConflictError); // stale version or already approved — never a second student
    expect(await m.prisma.studentEnrollment.count({ where: { sectionId: sec } })).toBe(1);
  });

  it("capacity is exact under concurrency; refused approvals leave nothing behind and consume no ID", async () => {
    const sec = await section("C", 3);
    const ids = await Promise.all(Array.from({ length: 6 }, () => ready(sec)));
    const [sBefore, aBefore] = [await counter("student_id"), await counter("admission_no")];
    const results = await Promise.allSettled(ids.map((id) => approve(principal, id)));
    const ok = results.filter((x) => x.status === "fulfilled");
    const refused = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
    expect(ok.length).toBeLessThanOrEqual(3);
    for (const r of refused) expect(r.reason instanceof m.ConflictError || r.reason instanceof m.ServiceBusyError).toBe(true);
    // Retry the busy ones one by one: the section ends exactly full, never over.
    for (const [i, r] of results.entries()) if (r.status === "rejected" && r.reason instanceof m.ServiceBusyError) await approve(principal, ids[i]).catch(() => undefined);
    expect(await m.prisma.studentEnrollment.count({ where: { sectionId: sec, status: "ACTIVE" } })).toBe(3);
    const registered = await m.prisma.admissionApplication.count({ where: { id: { in: ids }, status: "APPROVED" } });
    expect(registered).toBe(3);
    // Counters moved exactly once per registered student (rolled-back approvals consumed nothing).
    expect([(await counter("student_id")) - sBefore, (await counter("admission_no")) - aBefore]).toEqual([3, 3]);
    // Any application still waiting for this full section is refused with a clear "full" message.
    const waiting = await m.prisma.admissionApplication.findFirst({ where: { id: { in: ids }, status: { in: ["SUBMITTED", "UNDER_REVIEW"] } }, select: { id: true } });
    expect(waiting).not.toBeNull();
    await expect(approve(principal, waiting!.id)).rejects.toThrow(/is full \(3\/3\)/);
  });

  describe("50 simultaneous approvals (KI-010)", () => {
    let sec50: string;
    const ids50: string[] = [];
    /** 50 submitted applications with the section set — in batches of 5 (the pool size), outside the test's budget. */
    beforeAll(async () => {
      sec50 = await section("D", 60);
      const fixture = track(
        (async () => {
          for (let b = 0; b < 50; b += 5) ids50.push(...(await Promise.all(Array.from({ length: 5 }, () => ready(sec50)))));
        })(),
      );
      await fixture;
      expect(ids50).toHaveLength(50);
    }, 900_000);

    it("distinct IDs, no partial registrations; busy outcomes allowed and retried (D11)", async () => {
      const ids = ids50;
      const results = await Promise.allSettled(ids.map((id) => approve(principal, id)));
      const busy = results.filter((x): x is PromiseRejectedResult => x.status === "rejected");
      for (const r of busy) expect(r.reason).toBeInstanceOf(m.ServiceBusyError); // capacity 60 → only "busy" is acceptable
      for (const [i, r] of results.entries()) if (r.status === "rejected") await approve(principal, ids[i]);
      const students = await m.prisma.admissionApplication.findMany({ where: { id: { in: ids } }, select: { status: true, student: { select: { studentCode: true, admissionNo: true } } } });
      expect(students.every((s) => s.status === "APPROVED")).toBe(true);
      expect(new Set(students.map((s) => s.student!.studentCode)).size).toBe(50);
      expect(new Set(students.map((s) => s.student!.admissionNo)).size).toBe(50);
      expect(await m.prisma.studentEnrollment.count({ where: { sectionId: sec50 } })).toBe(50);
    }, 600_000);
  });

  it("siblings: an explicitly chosen guardian with the same phone is linked; a different phone is refused", async () => {
    const sec = await section("E", 40);
    const phone = "9876511122";
    const first = await approve(principal, await ready(sec, { phone }));
    const firstGuardian = (await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId: first.studentId } })).guardianId;
    const second = await ready(sec, { phone });
    const ag = await m.prisma.admissionGuardian.findFirstOrThrow({ where: { applicationId: second }, select: { id: true } });
    const matches = await m.guardianMatches(principal, second);
    expect(matches.get(ag.id)?.map((x) => x.id)).toEqual([firstGuardian]);
    const other = await approve(principal, await ready(sec, { phone: "9876599988" }));
    const otherGuardian = (await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId: other.studentId } })).guardianId;
    await expect(approve(principal, second, { guardianLinks: { [ag.id]: otherGuardian } })).rejects.toBeInstanceOf(m.ValidationError);
    const sibling = await approve(principal, second, { guardianLinks: { [ag.id]: firstGuardian } });
    expect((await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId: sibling.studentId } })).guardianId).toBe(firstGuardian);
    expect(await m.prisma.studentGuardian.count({ where: { guardianId: firstGuardian } })).toBe(2);
  });

  it("possible duplicates need a written reason; without a section approval is refused", async () => {
    const sec = await section("F", 40);
    const same = { lastName: `Twin${tag}`, dob: "2018-08-08" };
    await approve(principal, await ready(sec, same));
    const dup = await ready(sec, same);
    await expect(approve(principal, dup)).rejects.toThrow(/Give a reason to approve anyway/);
    const r = await approve(principal, dup, { duplicateOverride: "Different child — verified birth certificates" });
    expect(r.studentCode).toBeTruthy();
    const { id: noSection } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName: "Synthetic", middleName: null, lastName: "Nosection", dob: "2019-01-01", gender: "MALE" });
    await m.updateGuardiansStep(officer, { id: noSection, version: await version(noSection), guardians: [{ relation: "FATHER", name: "Synthetic Parent", phone: "9876512345", altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: false }] });
    await m.updateContactStep(officer, { id: noSection, version: await version(noSection), phone: null, email: null, address });
    await m.submitApplication(officer, noSection, await version(noSection));
    await expect(approve(principal, noSection)).rejects.toThrow(/Choose the section first/);
  });

  it("RBAC: only approvers register students (Admission Officer and Teacher get 403)", async () => {
    const sec = await section("G", 40);
    const id = await ready(sec);
    for (const ctx of [officer, teacher]) {
      await expect(approve(ctx, id)).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.guardianMatches(ctx, id)).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    expect((await approve(admin, id)).studentCode).toBeTruthy();
  });
});
