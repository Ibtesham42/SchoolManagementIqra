import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * PENDING until migration 20261110000000 is applied to the Neon "test" branch and TEST_DATABASE_URL is
 * configured — skipped otherwise (KI-043: runs only via `npm run test:integration`).
 * Phase 2 classes & sections: real transactions, unique indexes, CHECKs, row locks, audit rows and RBAC
 * (design docs/PHASE_2_CLASSES_SECTIONS_DESIGN.md §8). Synthetic data only; everything created here
 * is removed in afterAll.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("classes and sections (integration)", () => {
  const run = `ac${Date.now().toString(36)}`;
  // 4 random base-36 characters keep class codes (≤ 10) unique per run.
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const baseYear = 2200 + Math.floor(Math.random() * 600);
  const sessionInput = (y: number) => ({ name: `${y}-${String((y + 1) % 100).padStart(2, "0")}`, startDate: `${y}-04-01`, endDate: `${y + 1}-03-31` });
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, schoolAdmin: Ctx, teacher: Ctx, accountant: Ctx, parent: Ctx;
  let teacherId: string, teacher2Id: string, inactiveTeacherId: string, accountantId: string;
  const sessionIds: string[] = [];
  const classIds: string[] = [];

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string, extra: { isActive?: boolean } = {}) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", ...extra, roles: { create: { roleId: role.id } } } });
  }
  async function newSession(offset: number, status: "PLANNED" | "ACTIVE" = "PLANNED") {
    const s = await m.createAcademicSession(admin, sessionInput(baseYear + offset));
    sessionIds.push(s.id);
    if (status === "ACTIVE") await m.changeAcademicSessionStatus(admin, s.id, "ACTIVE");
    return s.id;
  }
  async function newClass(n: number, over: Partial<{ defaultSectionCapacity: number | null }> = {}) {
    const c = (await m.createClass(admin, { code: `${tag}-${n}`, name: `${run} Class ${n}`, numericLevel: n % 12, displayOrder: n, defaultSectionCapacity: null, ...over }))!;
    classIds.push(c.id);
    return c;
  }
  const sectionOf = (id: string) => m.prisma.section.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [root, sa, t, t2, tOff, acc, par] = await Promise.all([
      user("root", "SUPER_ADMIN"),
      user("sa", "SCHOOL_ADMIN"),
      user("t", "TEACHER"),
      user("t2", "CLASS_TEACHER"),
      user("toff", "TEACHER", { isActive: false }),
      user("acc", "ACCOUNTANT"),
      user("par", "PARENT"),
    ]);
    [admin, schoolAdmin, teacher, accountant, parent] = await Promise.all([ctxFor(root.id), ctxFor(sa.id), ctxFor(t.id), ctxFor(acc.id), ctxFor(par.id)]);
    teacherId = t.id;
    teacher2Id = t2.id;
    inactiveTeacherId = tOff.id;
    accountantId = acc.id;
  });

  afterAll(async () => {
    const { prisma } = m;
    await prisma.section.deleteMany({ where: { OR: [{ academicSessionId: { in: sessionIds } }, { classId: { in: classIds } }] } });
    await prisma.schoolClass.deleteMany({ where: { id: { in: classIds } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessionIds } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  });

  it("creates, updates and deactivates a class with audit rows; duplicates are refused case-insensitively", async () => {
    const c = await newClass(1);
    expect(c.version).toBe(1);
    await expect(m.createClass(admin, { code: `${tag}-1`, name: `${run} other`, numericLevel: 1, displayOrder: 0, defaultSectionCapacity: null })).rejects.toThrow(/code/);
    await expect(m.createClass(admin, { code: `${tag}-99`, name: `${run} CLASS 1`, numericLevel: 1, displayOrder: 0, defaultSectionCapacity: null })).rejects.toBeInstanceOf(m.ConflictError);
    await m.updateClass(admin, { id: c.id, version: 1, code: c.code, name: `${run} Class 1 renamed`, numericLevel: 1, displayOrder: 5, defaultSectionCapacity: 30 });
    await expect(m.updateClass(admin, { id: c.id, version: 1, code: c.code, name: "stale", numericLevel: 1, displayOrder: 5, defaultSectionCapacity: 30 })).rejects.toThrow(/changed by someone else/);
    await m.setClassActive(admin, c.id, 2, false);
    const row = await m.prisma.schoolClass.findUniqueOrThrow({ where: { id: c.id } });
    expect([row.isActive, row.version, row.nameKey]).toEqual([false, 3, `${run} class 1 renamed`]);
    expect(await m.prisma.auditLog.count({ where: { entityType: "SchoolClass", entityId: c.id } })).toBe(3);
    await m.setClassActive(admin, c.id, 3, true);
  });

  it("creates sections A–D with resolved capacity and derived codes; the class code is then fixed", async () => {
    const s = await newSession(0);
    const c = await newClass(2, { defaultSectionCapacity: 33 });
    const created = await m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["A", "B", "C", "D"], capacity: null });
    expect(created.map((x) => [x.code, x.capacity])).toEqual(["A", "B", "C", "D"].map((n) => [`${c.code}-${n}`, 33]));
    await expect(m.updateClass(admin, { id: c.id, version: c.version, code: `${tag}-X`, name: c.name, numericLevel: c.numericLevel, displayOrder: 0, defaultSectionCapacity: 33 })).rejects.toThrow(/code can't be changed/);
    // Duplicate (case-insensitive) → the whole batch rolls back.
    const before = await m.prisma.section.count({ where: { academicSessionId: s } });
    await expect(m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["E", "a"], capacity: null })).rejects.toThrow(/already has a section named "a"/);
    expect(await m.prisma.section.count({ where: { academicSessionId: s } })).toBe(before);
  });

  it("two concurrent creates of the same section: exactly one succeeds", async () => {
    const s = await newSession(2);
    const c = await newClass(3);
    const results = await Promise.allSettled([0, 1].map(() => m.createSection(admin, { academicSessionId: s, classId: c.id, name: "Rose", capacity: 40 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(m.ConflictError);
    expect(await m.prisma.section.count({ where: { academicSessionId: s, classId: c.id } })).toBe(1);
  });

  it("CLOSED sessions are read-only; inactive classes get no new sections", async () => {
    const s = await newSession(4, "ACTIVE");
    const c = await newClass(4);
    const [sec] = await m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["A"], capacity: null });
    await m.changeAcademicSessionStatus(admin, s, "CLOSED");
    await expect(m.createSection(admin, { academicSessionId: s, classId: c.id, name: "B", capacity: null })).rejects.toThrow(/closed/);
    await expect(m.updateSection(admin, { id: sec.id, version: 1, name: "A", capacity: 10 })).rejects.toThrow(/closed/);
    await expect(m.deleteSection(admin, sec.id, 1)).rejects.toThrow(/closed/);
    await expect(m.assignClassTeacher(admin, { id: sec.id, version: 1, userId: teacherId })).rejects.toThrow(/closed/);
    const open = await newSession(6);
    await m.setClassActive(admin, c.id, c.version, false);
    await expect(m.createSection(admin, { academicSessionId: open, classId: c.id, name: "A", capacity: null })).rejects.toThrow(/inactive/);
  });

  it("class teacher: eligible teachers only, one section per teacher per session, other sessions allowed", async () => {
    const s = await newSession(8);
    const s2 = await newSession(10);
    const c = await newClass(5);
    const [a, b] = await m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["A", "B"], capacity: null });
    const [other] = await m.createSectionsBulk(admin, { academicSessionId: s2, classId: c.id, names: ["A"], capacity: null });
    await expect(m.assignClassTeacher(admin, { id: a.id, version: 1, userId: inactiveTeacherId })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.assignClassTeacher(admin, { id: a.id, version: 1, userId: accountantId })).rejects.toBeInstanceOf(m.ValidationError);
    await m.assignClassTeacher(admin, { id: a.id, version: 1, userId: teacherId });
    await expect(m.assignClassTeacher(admin, { id: b.id, version: 1, userId: teacherId })).rejects.toThrow(/already class teacher/);
    await m.assignClassTeacher(admin, { id: other.id, version: 1, userId: teacherId }); // different session
    await m.assignClassTeacher(admin, { id: b.id, version: 1, userId: teacher2Id }); // CLASS_TEACHER role is eligible
    // The teacher reads only their own section; out-of-scope ids look missing.
    const mine = await m.listSections(teacher, { academicSessionId: s });
    expect(mine.map((x) => x.id)).toEqual([a.id]);
    await expect(m.getSection(teacher, b.id)).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.listClasses(teacher)).map((x) => x.id)).toContain(c.id);
    await m.unassignClassTeacher(admin, a.id, 2);
    expect((await sectionOf(a.id)).classTeacherId).toBeNull();
    const actions = (await m.prisma.auditLog.findMany({ where: { entityId: a.id }, select: { action: true } })).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["section.create", "section.class_teacher_assign", "section.class_teacher_unassign"]));
  });

  it("copy from session: active sections only, no class teachers, idempotent", async () => {
    const from = await newSession(12);
    const to = await newSession(14);
    const c = await newClass(6);
    const [a, b] = await m.createSectionsBulk(admin, { academicSessionId: from, classId: c.id, names: ["A", "B"], capacity: 35 });
    await m.createSectionsBulk(admin, { academicSessionId: from, classId: c.id, names: ["C"], capacity: null });
    await m.assignClassTeacher(admin, { id: a.id, version: 1, userId: teacherId });
    await m.setSectionActive(admin, b.id, 1, false);
    const first = await m.copySectionsFromSession(admin, { fromSessionId: from, toSessionId: to });
    expect(first).toEqual({ created: 2, skipped: 0 });
    const copied = await m.prisma.section.findMany({ where: { academicSessionId: to, classId: c.id }, orderBy: { name: "asc" } });
    const schoolDefault = await m.getDefaultSectionCapacity(admin);
    // A (capacity 35, teacher NOT copied) and C (resolved from the school default when created); B inactive → not copied.
    expect(copied.map((x) => [x.name, x.capacity, x.classTeacherId])).toEqual([
      ["A", 35, null],
      ["C", schoolDefault, null],
    ]);
    expect(await m.copySectionsFromSession(admin, { fromSessionId: from, toSessionId: to })).toEqual({ created: 0, skipped: 2 });
  });

  it("stale versions, capacity CHECK and FK RESTRICT are enforced", async () => {
    const s = await newSession(16);
    const c = await newClass(7);
    const [sec] = await m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["A"], capacity: null });
    await m.updateSection(admin, { id: sec.id, version: 1, name: "Lily", capacity: 25 });
    expect((await sectionOf(sec.id)).code).toBe(`${c.code}-LILY`);
    await expect(m.updateSection(admin, { id: sec.id, version: 1, name: "Lily", capacity: 30 })).rejects.toThrow(/changed by someone else/);
    await expect(m.prisma.section.update({ where: { id: sec.id }, data: { capacity: 0 } })).rejects.toThrow();
    await expect(m.prisma.section.update({ where: { id: sec.id }, data: { nameKey: "not-lower-of-name" } })).rejects.toThrow();
    await expect(m.prisma.schoolClass.delete({ where: { id: c.id } })).rejects.toThrow();
    await m.deleteSection(admin, sec.id, 2);
    expect(await m.prisma.section.count({ where: { id: sec.id } })).toBe(0);
  });

  it("a failed write leaves no audit row (same transaction)", async () => {
    const s = await newSession(18);
    const c = await newClass(8);
    await m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["A"], capacity: null });
    const before = await m.prisma.auditLog.count({ where: { action: "section.create", actorId: admin.userId } });
    await expect(m.createSectionsBulk(admin, { academicSessionId: s, classId: c.id, names: ["B", "A"], capacity: null })).rejects.toBeInstanceOf(m.ConflictError);
    expect(await m.prisma.auditLog.count({ where: { action: "section.create", actorId: admin.userId } })).toBe(before);
  });

  it("RBAC: School Admin manages; Teacher, Accountant and Parent get 403 on every write", async () => {
    const s = await newSession(20);
    const c = await newClass(9);
    const [sec] = await m.createSectionsBulk(schoolAdmin, { academicSessionId: s, classId: c.id, names: ["A"], capacity: null });
    const writes = (ctx: Ctx) => [
      () => m.createClass(ctx, { code: `${tag}-Z`, name: `${run} z`, numericLevel: 1, displayOrder: 0, defaultSectionCapacity: null }),
      () => m.updateClass(ctx, { id: c.id, version: 1, code: c.code, name: c.name, numericLevel: 1, displayOrder: 0, defaultSectionCapacity: null }),
      () => m.setClassActive(ctx, c.id, 1, false),
      () => m.createSection(ctx, { academicSessionId: s, classId: c.id, name: "B", capacity: null }),
      () => m.updateSection(ctx, { id: sec.id, version: 1, name: "A", capacity: 10 }),
      () => m.setSectionActive(ctx, sec.id, 1, false),
      () => m.deleteSection(ctx, sec.id, 1),
      () => m.assignClassTeacher(ctx, { id: sec.id, version: 1, userId: teacherId }),
      () => m.unassignClassTeacher(ctx, sec.id, 1),
      () => m.copySectionsFromSession(ctx, { fromSessionId: s, toSessionId: sessionIds[0] }),
      () => m.listEligibleClassTeachers(ctx),
      () => m.updateDefaultSectionCapacity(ctx, 41),
    ];
    for (const ctx of [teacher, accountant, parent]) {
      for (const w of writes(ctx)) await expect(w()).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    for (const ctx of [accountant, parent]) {
      await expect(m.listSections(ctx, { academicSessionId: s })).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.listClasses(ctx)).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    expect((await m.listSections(schoolAdmin, { academicSessionId: s })).map((x) => x.id)).toEqual([sec.id]);
  });
});
