import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 4A-M2 optional subjects per student against real Postgres (Neon Test branch only, behind the S-05 target guard;
 * skipped without TEST_DATABASE_URL). Real locks, the stale-screen check, active-enrollment filtering, composite FKs
 * and audit rows. Synthetic students in a far-future session; removed in afterAll except audit rows (S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/students/subject-choices.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("optional subjects per student (integration)", () => {
  const run = `ch${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx;
  let sessionId: string, sectionId: string, otherSectionId: string, csOptional: string, csCompulsory: string;
  const enr: string[] = [];
  let otherEnr: string;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: "SCHOOL_ADMIN" } });
    const u = await m.prisma.user.create({ data: { username: `${run}-admin`, displayName: "Synthetic admin", passwordHash: "x", roles: { create: { roleId: role.id } } } });
    admin = (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: new Date(`${Y}-04-01`), endDate: new Date(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}C11`, name: `${run} eleven`, nameKey: `${run} eleven`, numericLevel: 11 } })).id;
    const section = async (name: string) =>
      (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name, nameKey: name.toLowerCase(), code: `${tag}C11-${name}`, capacity: 40 } })).id;
    sectionId = await section("A");
    otherSectionId = await section("B");
    const subj = async (c: string) => (await m.prisma.subject.create({ data: { code: `${tag}${c}`, name: `${run} ${c}`, nameKey: `${run} ${c}`.toLowerCase() } })).id;
    csOptional = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("PE"), isOptional: true } })).id;
    csCompulsory = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("ENG") } })).id;
    const student = async (n: number, sec: string) => {
      const s = await m.prisma.student.create({
        data: {
          studentCode: `${tag}-STU-${n}`, admissionNo: `${tag}-ADM-${n}`, firstName: "Synthetic", fullName: `Synthetic Pupil ${n}`,
          fullNameNormalized: `synthetic pupil ${n}`, dob: new Date("2010-01-01T00:00:00.000Z"), gender: "OTHER",
          admissionDate: new Date(`${Y}-04-01T00:00:00.000Z`), admittedSessionId: sessionId,
        },
      });
      return (await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId: sec, enrolledOn: new Date(`${Y}-04-01`) } })).id;
    };
    for (let i = 1; i <= 3; i += 1) enr.push(await student(i, sectionId));
    otherEnr = await student(9, otherSectionId);
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.studentSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("sets, changes and clears who takes an optional subject; audit holds ids and counts", async () => {
    expect(await m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[0], enr[1]], expectedIds: [] })).toEqual({ added: 2, removed: 0 });
    let view = await m.getSectionChoices(admin, { sectionId });
    expect(view.roster).toHaveLength(3);
    expect(view.subjects.map((s) => s.id)).toEqual([csOptional]); // compulsory subjects aren't listed
    expect(new Set(view.subjects[0].chosen)).toEqual(new Set([enr[0], enr[1]]));
    expect(await m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[1], enr[2]], expectedIds: [enr[0], enr[1]] })).toEqual({ added: 1, removed: 1 });
    expect(await m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [], expectedIds: [enr[1], enr[2]] })).toEqual({ added: 0, removed: 2 });
    view = await m.getSectionChoices(admin, { sectionId });
    expect(view.subjects[0].chosen).toEqual([]);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student_subject.set", entityId: csOptional }, orderBy: { at: "asc" } });
    expect(JSON.stringify(log.after)).not.toMatch(/Synthetic Pupil/);
  });

  it("a stale screen is refused (someone else saved in between)", async () => {
    await m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[0]], expectedIds: [] });
    await expect(m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[1]], expectedIds: [] })).rejects.toThrow(/changed by someone else/);
  });

  it("refuses compulsory subjects, students of another section, and students who left", async () => {
    await expect(m.setSubjectChoices(admin, { sectionId, classSubjectId: csCompulsory, enrollmentIds: [enr[0]], expectedIds: [] })).rejects.toThrow(/compulsory/);
    await expect(m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[0], otherEnr], expectedIds: [enr[0]] })).rejects.toThrow(/no longer in this section/);
    await m.prisma.studentEnrollment.update({ where: { id: enr[2] }, data: { status: "LEFT", leftOn: new Date(`${Y}-06-01`) } });
    await expect(m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [enr[0], enr[2]], expectedIds: [enr[0]] })).rejects.toThrow(/no longer in this section/);
    expect((await m.getSectionChoices(admin, { sectionId })).roster.map((r) => r.enrollmentId)).not.toContain(enr[2]);
  });

  it("closed sessions are read-only", async () => {
    await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "CLOSED" } });
    await expect(m.setSubjectChoices(admin, { sectionId, classSubjectId: csOptional, enrollmentIds: [], expectedIds: [enr[0]] })).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "ACTIVE" } });
  });
});
