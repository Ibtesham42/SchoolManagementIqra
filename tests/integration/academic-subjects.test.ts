import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 4A-M2 subjects against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped without
 * TEST_DATABASE_URL). Real uniqueness (incl. case / Unicode name keys), CHECKs, row locks, versions and audit rows.
 * Synthetic data only; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/academic/subjects.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("academic subjects (integration)", () => {
  const run = `sj${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 800);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, teacher: Ctx, principal: Ctx;
  let sessionId: string, classId: string;
  const code = (c: string) => `${tag}${c}`;

  async function ctxFor(roleKey: string): Promise<Ctx> {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({
      data: { username: `${run}-${roleKey.toLowerCase()}`, displayName: `Synthetic ${roleKey}`, passwordHash: "x", roles: { create: { roleId: role.id } } },
    });
    const { token } = await m.createSession(u.id, { long: false });
    return (await m.validateSessionToken(token))!;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [admin, teacher, principal] = await Promise.all([ctxFor("SCHOOL_ADMIN"), ctxFor("TEACHER"), ctxFor("PRINCIPAL")]);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: new Date(`${Y}-04-01`), endDate: new Date(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: code("C"), name: `${run} class`, nameKey: `${run} class`, numericLevel: 6 } })).id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.classSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("creates a subject in any script; audit row written; duplicates by code or case-insensitive name refused", async () => {
    const s = await m.createSubject(admin, { code: code("HIN"), name: `हिन्दी ${run}`, kind: "SCHOLASTIC" });
    expect(s).toMatchObject({ code: code("HIN"), isActive: true, version: 1 });
    expect(await m.prisma.auditLog.count({ where: { action: "subject.create", entityId: s!.id } })).toBe(1);
    await expect(m.createSubject(admin, { code: code("HIN"), name: `Other ${run}`, kind: "SCHOLASTIC" })).rejects.toBeInstanceOf(m.ConflictError);
    await m.createSubject(admin, { code: code("MAT"), name: `Maths ${run}`, kind: "SCHOLASTIC" });
    await expect(m.createSubject(admin, { code: code("MAT2"), name: `MATHS ${run}`, kind: "SCHOLASTIC" })).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("edits with the current version only; code and kind fixed once a class studies the subject; name still editable", async () => {
    const s = (await m.createSubject(admin, { code: code("SCI"), name: `Science ${run}`, kind: "SCHOLASTIC" }))!;
    await m.updateSubject(admin, { id: s.id, version: 1, code: code("SCI"), name: `General science ${run}`, kind: "SCHOLASTIC" });
    await expect(m.updateSubject(admin, { id: s.id, version: 1, code: code("SCI"), name: `X ${run}`, kind: "SCHOLASTIC" })).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId, subjectId: s.id } });
    await expect(m.updateSubject(admin, { id: s.id, version: 2, code: code("SCX"), name: `General science ${run}`, kind: "SCHOLASTIC" })).rejects.toThrow(/can't change/);
    await expect(m.updateSubject(admin, { id: s.id, version: 2, code: code("SCI"), name: `General science ${run}`, kind: "CO_SCHOLASTIC" })).rejects.toThrow(/can't change/);
    await m.updateSubject(admin, { id: s.id, version: 2, code: code("SCI"), name: `Science and technology ${run}`, kind: "SCHOLASTIC" });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "subject.update", entityId: s.id }, orderBy: { at: "desc" } });
    expect(log.after).toMatchObject({ name: `Science and technology ${run}`, version: 3 });
  });

  it("deactivates (never deletes); the list shows inactive subjects only on request", async () => {
    const s = (await m.createSubject(admin, { code: code("OLD"), name: `Old subject ${run}`, kind: "CO_SCHOLASTIC" }))!;
    await m.setSubjectActive(admin, { id: s.id, version: 1, active: false });
    expect((await m.listSubjects(admin)).some((x) => x.id === s.id)).toBe(false);
    expect((await m.listSubjects(admin, { includeInactive: true })).find((x) => x.id === s.id)?.isActive).toBe(false);
  });

  it("RBAC: teachers and the Principal read but can't write", async () => {
    expect((await m.listSubjects(teacher)).length).toBeGreaterThan(0);
    expect((await m.listSubjects(principal)).length).toBeGreaterThan(0);
    await expect(m.createSubject(teacher, { code: code("T"), name: `T ${run}`, kind: "SCHOLASTIC" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.createSubject(principal, { code: code("P"), name: `P ${run}`, kind: "SCHOLASTIC" })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("database CHECKs back the input rules (bypassing the service)", async () => {
    await expect(m.prisma.subject.create({ data: { code: "bad code", name: "X", nameKey: `${run} bad` } })).rejects.toThrow();
    await expect(m.prisma.subject.create({ data: { code: code("WS"), name: "  padded ", nameKey: `${run} padded` } })).rejects.toThrow();
  });
});
