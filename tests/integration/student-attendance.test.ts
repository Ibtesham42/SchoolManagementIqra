import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 4A-M4 daily student attendance against real Postgres (Neon Test branch only, behind the S-05 target guard;
 * skipped without TEST_DATABASE_URL). Marking refuses future dates, so this suite uses a synthetic session in a random
 * PAST year (1995–2014; the staff-attendance suite uses 1942–1991). Synthetic students; removed in afterAll except
 * audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/students/student-attendance.service")),
  ...(await import("@/modules/hr/leave-setup.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("student attendance (integration)", () => {
  const run = `sa${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 1995 + Math.floor(Math.random() * 20);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let classTeacher: Ctx, otherTeacher: Ctx, admin: Ctx, principal: Ctx, hr: Ctx;
  let sessionId: string, sectionId: string, otherSection: string;
  const enr: string[] = [];
  let weeklyBefore: unknown;
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  /** n-th Monday of month mm in Y (+plus days), ISO. */
  const monday = (mm: number, n = 1, plus = 0) => {
    const x = d(`${Y}-${String(mm).padStart(2, "0")}-01`);
    while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() + 1);
    x.setUTCDate(x.getUTCDate() + 7 * (n - 1) + plus);
    return x.toISOString().slice(0, 10);
  };
  /** n-th Saturday of month mm in Y, ISO. */
  const saturday = (mm: number, n: number) => {
    const x = d(`${Y}-${String(mm).padStart(2, "0")}-01`);
    while (x.getUTCDay() !== 6) x.setUTCDate(x.getUTCDate() + 1);
    x.setUTCDate(x.getUTCDate() + 7 * (n - 1));
    return x.toISOString().slice(0, 10);
  };
  const entry = (enrollmentId: string, status = "PRESENT", version: number | null = null) => ({ enrollmentId, status: status as "PRESENT", version });
  const mark = (ctx: Ctx, date: string, entries: ReturnType<typeof entry>[], reason = "", section = sectionId) => m.markStudentDay(ctx, { sectionId: section, date, entries, reason });

  async function ctxFor(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [classTeacher, otherTeacher, admin, principal, hr] = [
      await ctxFor("ct", "CLASS_TEACHER"), await ctxFor("ot", "TEACHER"), await ctxFor("sa", "SCHOOL_ADMIN"), await ctxFor("pr", "PRINCIPAL"), await ctxFor("hr", "HR_MANAGER"),
    ];
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    const cls = (await m.prisma.schoolClass.create({ data: { code: `${tag}C3`, name: `${run} three`, nameKey: `${run} three`, numericLevel: 3 } })).id;
    sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name: "A", nameKey: "a", code: `${tag}C3-A`, capacity: 40, classTeacherId: classTeacher.userId } })).id;
    otherSection = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId: cls, name: "B", nameKey: "b", code: `${tag}C3-B`, capacity: 40, classTeacherId: otherTeacher.userId } })).id;
    for (let i = 1; i <= 3; i += 1) {
      const s = await m.prisma.student.create({
        data: {
          studentCode: `${tag}-STU-${i}`, admissionNo: `${tag}-ADM-${i}`, firstName: "Synthetic", fullName: `Synthetic Pupil ${i}`, fullNameNormalized: `synthetic pupil ${i}`,
          dob: d("1990-06-01"), gender: "OTHER", admissionDate: d(`${Y}-04-01`), admittedSessionId: sessionId,
        },
      });
      // Pupil 3 joins in July.
      enr.push((await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId, enrolledOn: d(i === 3 ? `${Y}-07-01` : `${Y}-04-01`) } })).id);
    }
    const s = await m.prisma.schoolSetting.findFirst({ select: { studentWeeklyOff: true } });
    weeklyBefore = s?.studentWeeklyOff ?? null;
    await m.prisma.schoolSetting.updateMany({ data: { studentWeeklyOff: { days: [0], saturdays: [2, 4] } } });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.studentAttendance.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.holiday.deleteMany({ where: { date: { gte: d(`${Y}-04-01`), lte: d(`${Y + 1}-03-31`) } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.schoolSetting.updateMany({ data: { studentWeeklyOff: weeklyBefore === null ? { days: [], saturdays: [] } : (weeklyBefore as object) } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("the class teacher marks a school day; audit has counts, no names", async () => {
    const day = monday(5, 1);
    expect(await mark(classTeacher, day, [entry(enr[0]), entry(enr[1], "ABSENT")])).toEqual({ created: 2, changed: 0 });
    const view = await m.getStudentDay(classTeacher, { sectionId, date: day });
    expect(view.roster.map((r) => r.mark?.status)).toEqual(["PRESENT", "ABSENT"]); // pupil 3 not yet enrolled in May
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student_attendance.mark", entityId: sectionId }, orderBy: { at: "desc" } });
    expect(JSON.stringify(log.after)).not.toMatch(/Synthetic Pupil/);
  });

  it("refuses: another class teacher's section (looks missing), weekly offs, student holidays, future dates, students not yet enrolled", async () => {
    await expect(mark(otherTeacher, monday(5, 2), [entry(enr[0])])).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.getStudentDay(otherTeacher, { sectionId, date: monday(5, 2) })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(mark(classTeacher, monday(5, 2, -1), [entry(enr[0])])).rejects.toThrow(/weekly off/); // Sunday
    await expect(mark(classTeacher, saturday(5, 2), [entry(enr[0])])).rejects.toThrow(/weekly off/); // 2nd Saturday
    await m.createHoliday(hr, { date: monday(5, 3), name: "Synthetic pupils day", appliesTo: "STUDENTS" });
    await expect(mark(classTeacher, monday(5, 3), [entry(enr[0])])).rejects.toThrow(/holiday/);
    await m.createHoliday(hr, { date: monday(5, 3, 1), name: "Synthetic staff day", appliesTo: "STAFF" });
    expect((await mark(classTeacher, monday(5, 3, 1), [entry(enr[0])])).created).toBe(1); // staff-only holiday is a school day
    await expect(mark(classTeacher, "2999-01-05", [entry(enr[0])])).rejects.toBeInstanceOf(m.ValidationError);
    await expect(mark(classTeacher, monday(5, 4), [entry(enr[2])])).rejects.toThrow(/wasn't in this section/);
  });

  it("AC7: the class teacher can't change an earlier day; the office corrects it with a reason (reason not audited)", async () => {
    const day = monday(5, 1);
    const view = await m.getStudentDay(admin, { sectionId, date: day });
    const absent = view.roster.find((r) => r.mark?.status === "ABSENT")!;
    await expect(mark(classTeacher, day, [entry(absent.enrollmentId, "PRESENT", absent.mark!.version)])).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(mark(admin, day, [entry(absent.enrollmentId, "EXCUSED", absent.mark!.version)])).rejects.toBeInstanceOf(m.ValidationError);
    await expect(mark(admin, day, [entry(absent.enrollmentId, "EXCUSED", absent.mark!.version + 3)], "Synthetic SECRET-R")).rejects.toThrow(/changed by someone else/);
    expect(await mark(admin, day, [entry(absent.enrollmentId, "EXCUSED", absent.mark!.version)], "Synthetic SECRET-R")).toEqual({ created: 0, changed: 1 });
    const row = await m.prisma.studentAttendance.findFirstOrThrow({ where: { enrollmentId: absent.enrollmentId, date: d(day) } });
    expect(row).toMatchObject({ status: "EXCUSED", correctionReason: "Synthetic SECRET-R" });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "student_attendance.correct", entityId: sectionId } });
    expect(JSON.stringify(log)).not.toContain("SECRET-R");
  });

  it("read-only roles: the Principal reads but can't mark; HR (no student permissions) is refused", async () => {
    expect((await m.getStudentDay(principal, { sectionId, date: monday(5, 1) })).canMarkNew).toBe(false);
    await expect(mark(principal, monday(6, 1), [entry(enr[0])])).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.getStudentDay(hr, { sectionId, date: monday(5, 1) })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("a holiday for students can't be added on a day with student attendance; the month register counts it", async () => {
    await expect(m.createHoliday(hr, { date: monday(5, 1), name: "Too late", appliesTo: "ALL" })).rejects.toThrow(/already recorded/);
    const reg = await m.getStudentMonth(classTeacher, { sectionId, month: `${Y}-05` });
    const p1 = reg.items.find((i) => i.enrollmentId === enr[0])!;
    expect(p1.summary.present).toBe(2);
    expect(reg.items.find((i) => i.enrollmentId === enr[1])!.summary.excused).toBe(1);
    expect(reg.items.some((i) => i.enrollmentId === enr[2])).toBe(false); // joined in July
  });

  it("concurrent first marks of the same day: one wins, the other is told to reload", async () => {
    const day = monday(6, 2);
    const results = await Promise.allSettled([mark(classTeacher, day, [entry(enr[0])]), mark(admin, day, [entry(enr[0], "ABSENT")])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await m.prisma.studentAttendance.count({ where: { enrollmentId: enr[0], date: d(day) } })).toBe(1);
  });
});
