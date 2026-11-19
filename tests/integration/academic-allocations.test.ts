import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 4A-M2 teacher allocation against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped
 * without TEST_DATABASE_URL). Real employee / login eligibility, session / section / class-subject locks, the one-
 * teacher-per-subject unique index, versions, the timetable guard and audit rows. Synthetic data, far-future sessions.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/academic/allocations.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("academic teacher allocation (integration)", () => {
  const run = `al${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx;
  let sessionId: string, closedId: string, sectionId: string, otherSectionId: string, closedSectionId: string, csMath: string, csOther: string, csClosed: string;
  let t1: string, t2: string, nonTeaching: string, unlinked: string;

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const a = await user("admin", "SCHOOL_ADMIN");
    admin = (await m.validateSessionToken((await m.createSession(a.id, { long: false })).token))!;
    t1 = await linkTeachingEmployee(m.prisma, tag, (await user("t1", "TEACHER")).id);
    t2 = await linkTeachingEmployee(m.prisma, tag, (await user("t2", "TEACHER")).id);
    nonTeaching = await linkTeachingEmployee(m.prisma, tag, (await user("nt", "LIBRARIAN")).id, { staffType: "NON_TEACHING" });
    const loose = await user("loose", "TEACHER");
    unlinked = await linkTeachingEmployee(m.prisma, tag, loose.id);
    await m.prisma.user.update({ where: { id: loose.id }, data: { employeeId: null } }); // employee without a login
    const session = async (y: number, status: "ACTIVE" | "CLOSED") =>
      (await m.prisma.academicSession.create({ data: { name: `${run}-${y}`, startDate: new Date(`${y}-04-01`), endDate: new Date(`${y + 1}-03-31`), status } })).id;
    sessionId = await session(Y, "ACTIVE");
    closedId = await session(Y + 1, "CLOSED");
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}C8`, name: `${run} eight`, nameKey: `${run} eight`, numericLevel: 8 } })).id;
    const cls2 = (await m.prisma.schoolClass.create({ data: { code: `${tag}C9`, name: `${run} nine`, nameKey: `${run} nine`, numericLevel: 9 } })).id;
    const subj = (await m.prisma.subject.create({ data: { code: `${tag}MAT`, name: `${run} maths`, nameKey: `${run} maths` } })).id;
    const section = async (sess: string, classId: string, name: string, code: string) =>
      (await m.prisma.section.create({ data: { academicSessionId: sess, classId, name, nameKey: name.toLowerCase(), code, capacity: 40 } })).id;
    sectionId = await section(sessionId, cls, "A", `${tag}C8-A`);
    otherSectionId = await section(sessionId, cls2, "A", `${tag}C9-A`);
    closedSectionId = await section(closedId, cls, "A", `${tag}C8-A`);
    csMath = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: subj } })).id;
    csOther = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls2, subjectId: subj } })).id;
    csClosed = (await m.prisma.classSubject.create({ data: { academicSessionId: closedId, classId: cls, subjectId: subj } })).id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const sessions = [sessionId, closedId].filter(Boolean);
    await prisma.timetableSlot.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.period.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.teacherAllocation.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.section.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessions } } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("allocates an eligible teacher; refuses non-teaching staff, employees without a login, wrong-class subjects and closed sessions", async () => {
    await m.assignTeacher(admin, { sectionId, classSubjectId: csMath, employeeId: t1, version: null });
    const list = await m.listSectionAllocations(admin, { sectionId });
    expect(list.items[0].allocation).toMatchObject({ employeeId: t1, current: true, version: 1 });
    expect(await m.prisma.auditLog.count({ where: { action: "teacher_allocation.assign", entityId: list.items[0].allocation!.id } })).toBe(1);
    await expect(m.assignTeacher(admin, { sectionId: otherSectionId, classSubjectId: csOther, employeeId: nonTeaching, version: null })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.assignTeacher(admin, { sectionId: otherSectionId, classSubjectId: csOther, employeeId: unlinked, version: null })).rejects.toThrow(/no active login/);
    await expect(m.assignTeacher(admin, { sectionId: otherSectionId, classSubjectId: csMath, employeeId: t1, version: null })).rejects.toThrow(/isn't taught/);
    await expect(m.assignTeacher(admin, { sectionId: closedSectionId, classSubjectId: csClosed, employeeId: t1, version: null })).rejects.toBeInstanceOf(m.ConflictError);
    expect((await m.listAllocatableTeachers(admin)).map((t) => t.id)).toEqual(expect.arrayContaining([t1, t2]));
    expect((await m.listAllocatableTeachers(admin)).map((t) => t.id)).not.toContain(nonTeaching);
    expect((await m.listAllocatableTeachers(admin)).map((t) => t.id)).not.toContain(unlinked);
  });

  it("one teacher per subject per section: a stale first allocation is refused; concurrent first allocations → one wins", async () => {
    await expect(m.assignTeacher(admin, { sectionId, classSubjectId: csMath, employeeId: t2, version: null })).rejects.toThrow(/changed by someone else/);
    const results = await Promise.allSettled([
      m.assignTeacher(admin, { sectionId: otherSectionId, classSubjectId: csOther, employeeId: t1, version: null }),
      m.assignTeacher(admin, { sectionId: otherSectionId, classSubjectId: csOther, employeeId: t2, version: null }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await m.prisma.teacherAllocation.count({ where: { sectionId: otherSectionId } })).toBe(1);
  });

  it("changing or removing a teacher is refused while the timetable names them; works once the slot is gone", async () => {
    const alloc = (await m.listSectionAllocations(admin, { sectionId })).items[0].allocation!;
    const period = await m.prisma.period.create({
      data: { academicSessionId: sessionId, dayOfWeek: 1, number: 1, startTime: new Date("1970-01-01T08:00:00Z"), endTime: new Date("1970-01-01T08:40:00Z") },
    });
    const slot = await m.prisma.timetableSlot.create({ data: { academicSessionId: sessionId, sectionId, periodId: period.id, classSubjectId: csMath, employeeId: t1 } });
    await expect(m.assignTeacher(admin, { sectionId, classSubjectId: csMath, employeeId: t2, version: alloc.version })).rejects.toThrow(/timetable/);
    await expect(m.removeAllocation(admin, { id: alloc.id, version: alloc.version })).rejects.toThrow(/timetable/);
    await m.prisma.timetableSlot.delete({ where: { id: slot.id } });
    await m.assignTeacher(admin, { sectionId, classSubjectId: csMath, employeeId: t2, version: alloc.version });
    const changed = (await m.listSectionAllocations(admin, { sectionId })).items[0].allocation!;
    expect(changed).toMatchObject({ employeeId: t2, version: alloc.version + 1 });
    await m.removeAllocation(admin, { id: changed.id, version: changed.version });
    expect(await m.prisma.teacherAllocation.count({ where: { id: changed.id } })).toBe(0);
  });

  it("a teacher who later leaves shows as no longer current (the allocation is kept for history until replaced)", async () => {
    await m.assignTeacher(admin, { sectionId, classSubjectId: csMath, employeeId: t1, version: null });
    await m.prisma.employee.update({ where: { id: t1 }, data: { employmentStatus: "RESIGNED", leavingDate: new Date("2026-01-01"), leavingReason: "Synthetic" } });
    expect((await m.listSectionAllocations(admin, { sectionId })).items[0].allocation?.current).toBe(false);
  });

  it("the database refuses an allocation across sessions (composite FK)", async () => {
    await expect(
      m.prisma.teacherAllocation.create({ data: { academicSessionId: sessionId, sectionId: closedSectionId, classSubjectId: csMath, employeeId: t2 } }),
    ).rejects.toThrow();
  });
});
