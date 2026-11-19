import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 4A-M2 class subjects against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped
 * without TEST_DATABASE_URL). Real session / class / subject locks, uniqueness, versions, composite FKs and audit rows.
 * Synthetic data only, in far-future sessions; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/academic/class-subjects.service")),
  ...(await import("@/modules/academic/subjects.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("academic class subjects (integration)", () => {
  const run = `cs${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx;
  let s1: string, s2: string, closed: string, classId: string, inactiveClass: string;
  let math: string, eng: string, art: string, old: string;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "SCHOOL_ADMIN" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-admin`, displayName: "Synthetic admin", passwordHash: "x", roles: { create: { roleId: role.id } } } });
    admin = (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
    const session = async (y: number, status: "ACTIVE" | "PLANNED" | "CLOSED") =>
      (await m.prisma.academicSession.create({ data: { name: `${run}-${y}`, startDate: new Date(`${y}-04-01`), endDate: new Date(`${y + 1}-03-31`), status } })).id;
    [s1, s2, closed] = [await session(Y, "ACTIVE"), await session(Y + 1, "PLANNED"), await session(Y + 2, "CLOSED")];
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C6`, name: `${run} six`, nameKey: `${run} six`, numericLevel: 6 } })).id;
    inactiveClass = (await m.prisma.schoolClass.create({ data: { code: `${tag}C7`, name: `${run} seven`, nameKey: `${run} seven`, numericLevel: 7, isActive: false } })).id;
    const subj = async (c: string, active = true) =>
      (await m.prisma.subject.create({ data: { code: `${tag}${c}`, name: `${run} ${c}`, nameKey: `${run} ${c}`.toLowerCase(), isActive: active } })).id;
    [math, eng, art, old] = [await subj("MAT"), await subj("ENG"), await subj("ART"), await subj("OLD", false)];
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const sessions = [s1, s2, closed].filter(Boolean);
    await prisma.studentSubject.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.section.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessions } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("adds active subjects in order; refuses duplicates, inactive subjects, inactive classes and closed sessions", async () => {
    expect(await m.addClassSubjects(admin, { academicSessionId: s1, classId, subjectIds: [math, eng], isOptional: false })).toEqual({ added: 2 });
    expect(await m.addClassSubjects(admin, { academicSessionId: s1, classId, subjectIds: [art], isOptional: true })).toEqual({ added: 1 });
    const list = await m.listClassSubjects(admin, { academicSessionId: s1, classId });
    expect(list.items.map((i) => [i.subject.code.slice(4), i.isOptional])).toEqual([
      [expect.any(String), false],
      [expect.any(String), false],
      ["ART", true],
    ]);
    await expect(m.addClassSubjects(admin, { academicSessionId: s1, classId, subjectIds: [math], isOptional: false })).rejects.toThrow(/already in this class/);
    await expect(m.addClassSubjects(admin, { academicSessionId: s1, classId, subjectIds: [old], isOptional: false })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.addClassSubjects(admin, { academicSessionId: s1, classId: inactiveClass, subjectIds: [math], isOptional: false })).rejects.toThrow(/inactive/);
    await expect(m.addClassSubjects(admin, { academicSessionId: closed, classId, subjectIds: [math], isOptional: false })).rejects.toBeInstanceOf(m.ConflictError);
    expect(await m.prisma.auditLog.count({ where: { action: "class_subject.add", entityId: classId } })).toBe(2);
  });

  it("concurrent adds of the same subject: one wins, the other is told to reload", async () => {
    const results = await Promise.allSettled([
      m.addClassSubjects(admin, { academicSessionId: s2, classId, subjectIds: [math], isOptional: false }),
      m.addClassSubjects(admin, { academicSessionId: s2, classId, subjectIds: [math], isOptional: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(m.ConflictError);
  });

  it("an optional subject with student choices can't become compulsory or be removed; versions are enforced", async () => {
    const artRow = (await m.listClassSubjects(admin, { academicSessionId: s1, classId })).items.find((i) => i.subject.id === art)!;
    // A synthetic student + enrollment (direct fixture writes; the composite FK needs a real enrollment).
    const student = await m.prisma.student.create({
      data: {
        studentCode: `${tag}-STU-1`,
        admissionNo: `${tag}-ADM-1`,
        firstName: "Synthetic",
        fullName: "Synthetic Pupil",
        fullNameNormalized: "synthetic pupil",
        dob: new Date("2015-01-01T00:00:00.000Z"),
        gender: "OTHER",
        admissionDate: new Date(`${Y}-04-01T00:00:00.000Z`),
        admittedSessionId: s1,
      },
      select: { id: true },
    });
    const section = await m.prisma.section.create({ data: { academicSessionId: s1, classId, name: "A", nameKey: "a", code: `${tag}C6-A`, capacity: 40 } });
    const enr = await m.prisma.studentEnrollment.create({ data: { studentId: student.id, academicSessionId: s1, sectionId: section.id, enrolledOn: new Date(`${Y}-04-01`) } });
    await m.prisma.studentSubject.create({ data: { academicSessionId: s1, enrollmentId: enr.id, classSubjectId: artRow.id } });
    await expect(m.updateClassSubject(admin, { id: artRow.id, version: artRow.version, isOptional: false, sortOrder: artRow.sortOrder })).rejects.toThrow(/chose/);
    await expect(m.removeClassSubject(admin, { id: artRow.id, version: artRow.version })).rejects.toThrow(/in use/);
    // The database keeps a choice in the enrollment's session (composite FK): a choice in another session is refused.
    const s2Row = await m.prisma.classSubject.findFirstOrThrow({ where: { academicSessionId: s2 }, select: { id: true } });
    await expect(m.prisma.studentSubject.create({ data: { academicSessionId: s2, enrollmentId: enr.id, classSubjectId: s2Row.id } })).rejects.toThrow();
    await m.prisma.studentSubject.deleteMany({ where: { enrollmentId: enr.id } });
    await m.prisma.studentEnrollment.delete({ where: { id: enr.id } });
    await m.prisma.student.delete({ where: { id: student.id } });
    await m.prisma.section.delete({ where: { id: section.id } });
    await m.updateClassSubject(admin, { id: artRow.id, version: artRow.version, isOptional: true, sortOrder: 9 });
    await expect(m.updateClassSubject(admin, { id: artRow.id, version: artRow.version, isOptional: true, sortOrder: 3 })).rejects.toThrow(/changed by someone else/);
    await m.removeClassSubject(admin, { id: artRow.id, version: artRow.version + 1 });
    expect(await m.prisma.classSubject.count({ where: { id: artRow.id } })).toBe(0);
  });

  it("copies a session's plan (active classes and subjects only), keeping existing mappings; never into a closed session", async () => {
    const r = await m.copyClassSubjects(admin, { fromSessionId: s1, toSessionId: s2 });
    expect(r.created + r.skipped).toBe(2); // math (already in s2) + eng
    expect(r.skipped).toBe(1);
    await expect(m.copyClassSubjects(admin, { fromSessionId: s1, toSessionId: closed })).rejects.toBeInstanceOf(m.ConflictError);
  });
});
