import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 4A-M3 period plan and timetable against real Postgres (Neon Test branch only, behind the S-05 target guard;
 * skipped without TEST_DATABASE_URL). Real advisory / row locks, the double-booking indexes, the allocation guard,
 * stale-screen checks and audit rows. Synthetic data in far-future sessions; removed in afterAll except audit rows.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/academic/timetable.service")),
  ...(await import("@/modules/academic/allocations.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("academic timetable (integration)", () => {
  const run = `tt${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let admin: Ctx, teacher: Ctx;
  let sessionId: string, secA: string, secB: string, csMathA: string, csEng: string, t1: string;
  const P = (s: string, e: string, kind: "TEACHING" | "BREAK" = "TEACHING") => ({ startTime: s, endTime: e, kind, label: null });

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const ctxOf = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;
  const day = async (d: number) => (await m.getPeriodPlan(admin, sessionId)).days[d];

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    admin = await ctxOf((await user("admin", "SCHOOL_ADMIN")).id);
    const tu = await user("t1", "TEACHER");
    t1 = await linkTeachingEmployee(m.prisma, tag, tu.id);
    teacher = await ctxOf(tu.id);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: new Date(`${Y}-04-01`), endDate: new Date(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}C5`, name: `${run} five`, nameKey: `${run} five`, numericLevel: 5 } })).id;
    const sec = async (n: string) => (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name: n, nameKey: n.toLowerCase(), code: `${tag}C5-${n}`, capacity: 40 } })).id;
    secA = await sec("A");
    secB = await sec("B");
    const subj = async (c: string) => (await m.prisma.subject.create({ data: { code: `${tag}${c}`, name: `${run} ${c}`, nameKey: `${run} ${c}`.toLowerCase() } })).id;
    csMathA = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("MAT") } })).id;
    csEng = (await m.prisma.classSubject.create({ data: { academicSessionId: sessionId, classId: cls, subjectId: await subj("ENG") } })).id;
    await m.assignTeacher(admin, { sectionId: secA, classSubjectId: csMathA, employeeId: t1, version: null });
    await m.assignTeacher(admin, { sectionId: secB, classSubjectId: csMathA, employeeId: t1, version: null });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.timetableSlot.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.period.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.teacherAllocation.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.classSubject.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.subject.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("saves a day's plan, refuses a stale screen, copies it to other days", async () => {
    expect(await m.saveDayPlan(admin, { academicSessionId: sessionId, dayOfWeek: 1, fingerprint: "", periods: [P("08:00", "08:40"), P("08:40", "09:20"), P("09:20", "09:35", "BREAK")] })).toEqual({ created: 3, updated: 0, removed: 0 });
    await expect(m.saveDayPlan(admin, { academicSessionId: sessionId, dayOfWeek: 1, fingerprint: "", periods: [P("08:00", "08:40")] })).rejects.toThrow(/changed by someone else/);
    expect(await m.copyDayPlan(admin, { academicSessionId: sessionId, fromDay: 1, toDays: [2, 3], fingerprints: {} })).toEqual({ days: 2, periods: 3 });
    expect((await day(2)).periods.map((p) => [p.number, p.startTime, p.kind])).toEqual([
      [1, "08:00", "TEACHING"],
      [2, "08:40", "TEACHING"],
      [3, "09:20", "BREAK"],
    ]);
  });

  it("a lesson takes the allocated teacher; the teacher can't be in two sections at once; breaks refuse lessons", async () => {
    const mon = await day(1);
    const [p1, p2, br] = mon.periods;
    expect(await m.setSlot(admin, { sectionId: secA, periodId: p1.id, classSubjectId: csMathA, version: null })).toEqual({ changed: true, teacherAssigned: true });
    const slot = await m.prisma.timetableSlot.findFirstOrThrow({ where: { sectionId: secA, periodId: p1.id } });
    expect(slot.employeeId).toBe(t1);
    await expect(m.setSlot(admin, { sectionId: secB, periodId: p1.id, classSubjectId: csMathA, version: null })).rejects.toThrow(/already teaches/);
    expect((await m.setSlot(admin, { sectionId: secB, periodId: p2.id, classSubjectId: csMathA, version: null })).changed).toBe(true);
    expect(await m.setSlot(admin, { sectionId: secA, periodId: p2.id, classSubjectId: csEng, version: null })).toEqual({ changed: true, teacherAssigned: false });
    await expect(m.setSlot(admin, { sectionId: secA, periodId: br.id, classSubjectId: csEng, version: null })).rejects.toThrow(/break/);
    await expect(m.setSlot(admin, { sectionId: secA, periodId: p1.id, classSubjectId: csEng, version: null })).rejects.toThrow(/changed by someone else/);
  });

  it("periods with lessons can't be removed or turned into breaks; allocations named by the timetable can't change", async () => {
    const mon = await day(1);
    await expect(m.saveDayPlan(admin, { academicSessionId: sessionId, dayOfWeek: 1, fingerprint: mon.fingerprint, periods: [P("08:00", "08:40", "BREAK"), P("08:40", "09:20"), P("09:20", "09:35", "BREAK")] })).rejects.toThrow(/can't become a break/);
    await expect(m.saveDayPlan(admin, { academicSessionId: sessionId, dayOfWeek: 1, fingerprint: mon.fingerprint, periods: [P("08:00", "08:40")] })).rejects.toThrow(/has lessons/);
    // Times can still move.
    expect((await m.saveDayPlan(admin, { academicSessionId: sessionId, dayOfWeek: 1, fingerprint: mon.fingerprint, periods: [P("08:05", "08:45"), P("08:45", "09:25"), P("09:25", "09:40", "BREAK")] })).updated).toBe(3);
    await expect(m.copyDayPlan(admin, { academicSessionId: sessionId, fromDay: 2, toDays: [1], fingerprints: { "1": (await day(1)).fingerprint } })).rejects.toThrow(/already has lessons/);
    await expect(m.copyDayPlan(admin, { academicSessionId: sessionId, fromDay: 1, toDays: [4], fingerprints: { "4": "stale" } })).rejects.toThrow(/changed by someone else/);
    const alloc = (await m.listSectionAllocations(admin, { sectionId: secA })).items.find((i) => i.classSubjectId === csMathA)!.allocation!;
    await expect(m.removeAllocation(admin, { id: alloc.id, version: alloc.version })).rejects.toThrow(/timetable/);
  });

  it("My timetable lists the teacher's own lessons across sections", async () => {
    const mine = await m.getMyTimetable(teacher, sessionId);
    expect(mine.linked).toBe(true);
    if (!mine.linked) return;
    expect(mine.slots.map((s) => s.section.code).sort()).toEqual([`${tag}C5-A`, `${tag}C5-B`]);
  });

  it("clearing a lesson frees the period; the database refuses double-booking even past the service", async () => {
    const mon = await day(1);
    const slotA = await m.prisma.timetableSlot.findFirstOrThrow({ where: { sectionId: secA, periodId: mon.periods[0].id } });
    await expect(m.prisma.timetableSlot.create({ data: { academicSessionId: sessionId, sectionId: secB, periodId: mon.periods[0].id, classSubjectId: csMathA, employeeId: t1 } })).rejects.toThrow();
    await m.setSlot(admin, { sectionId: secA, periodId: mon.periods[0].id, classSubjectId: null, version: slotA.version });
    expect(await m.prisma.timetableSlot.count({ where: { id: slotA.id } })).toBe(0);
    expect(await m.prisma.auditLog.count({ where: { action: "timetable_slot.clear", entityId: slotA.id } })).toBe(1);
  });
});
