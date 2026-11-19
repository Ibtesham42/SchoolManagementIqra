import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3B M4 — staff attendance marking, corrections and reads against real Postgres (Neon Test branch only, behind
 * the S-05 target guard; skipped without TEST_DATABASE_URL). Marking refuses future dates, so this suite uses a
 * synthetic academic session in a random PAST year (1942–1991, far before any real session) and moves its fixture
 * employees' joining dates back to 1941. Synthetic data only; removed in afterAll except audit rows (append-only).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/hr/staff-attendance.service")),
  ...(await import("@/modules/hr/leave-requests.service")),
  ...(await import("@/modules/hr/leave-setup.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR staff attendance (integration)", () => {
  const run = `sa${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 1942 + Math.floor(Math.random() * 50);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, hrUnlinked: Ctx, principal: Ctx, teacher: Ctx, teacher2: Ctx, superAdmin: Ctx;
  let empHr: string, empT: string, empT2: string, empLate: string, sessionId: string;
  let weeklyOffBefore: unknown;
  const roleCtx: Record<string, Ctx> = {};
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  /** The n-th Monday (1-based) of month `mm` in year Y, as ISO; plus `plus` days. */
  const monday = (mm: number, n = 1, plus = 0) => {
    const x = d(`${Y}-${String(mm).padStart(2, "0")}-01`);
    while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() + 1);
    x.setUTCDate(x.getUTCDate() + 7 * (n - 1) + plus);
    return iso(x);
  };
  const entry = (employeeId: string, over: Record<string, unknown> = {}) => ({
    employeeId,
    status: "PRESENT" as const,
    checkIn: null,
    checkOut: null,
    version: null as number | null,
    ...over,
  });
  const mark = (ctx: Ctx, date: string, entries: ReturnType<typeof entry>[], reason = "") =>
    m.markAttendanceDay(ctx, { date, entries, reason } as Parameters<typeof m.markAttendanceDay>[1]);
  const row = (employeeId: string, date: string) =>
    m.prisma.employeeAttendance.findUnique({ where: { employeeId_date: { employeeId, date: d(date) } } });

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({
      data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } },
    });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, hu, p, t, t2, sa, late] = await Promise.all([
      user("hr", "HR_MANAGER"),
      user("hru", "HR_MANAGER"),
      user("pr", "PRINCIPAL"),
      user("t", "TEACHER"),
      user("t2", "TEACHER"),
      user("sa", "SUPER_ADMIN"),
      user("late", "LIBRARIAN"),
    ]);
    empHr = await linkTeachingEmployee(m.prisma, tag, h.id, { staffType: "NON_TEACHING" });
    const empP = await linkTeachingEmployee(m.prisma, tag, p.id);
    empT = await linkTeachingEmployee(m.prisma, tag, t.id);
    empT2 = await linkTeachingEmployee(m.prisma, tag, t2.id);
    empLate = await linkTeachingEmployee(m.prisma, tag, late.id, { staffType: "NON_TEACHING" });
    // Joining dates before the past-year session (dob ≥ 1940 and dob < joining — DB CHECK).
    await m.prisma.employee.updateMany({
      where: { id: { in: [empHr, empP, empT, empT2] } },
      data: { dob: d("1940-01-01"), joiningDate: d("1941-01-01") },
    });
    // This one joins mid-June of Y: not on the rolls before.
    await m.prisma.employee.update({ where: { id: empLate }, data: { dob: d("1940-01-01"), joiningDate: d(`${Y}-06-15`) } });
    [hr, hrUnlinked, principal, teacher, teacher2, superAdmin] = await Promise.all([h, hu, p, t, t2, sa].map((u) => ctxFor(u.id)));
    for (const key of [
      "SCHOOL_ADMIN", "VICE_PRINCIPAL", "ACCOUNTANT", "ADMISSION_OFFICER", "CLASS_TEACHER", "TRANSPORT_MANAGER", "LIBRARIAN", "PARENT", "STUDENT",
    ]) {
      roleCtx[key] = await ctxFor((await user(`r-${key.toLowerCase()}`, key)).id);
    }
    Object.assign(roleCtx, { HR_MANAGER: hr, PRINCIPAL: principal, TEACHER: teacher, SUPER_ADMIN: superAdmin });
    sessionId = (
      await m.prisma.academicSession.create({
        data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" },
        select: { id: true },
      })
    ).id;
    const s = await m.prisma.schoolSetting.findFirst({ select: { weeklyOff: true } });
    weeklyOffBefore = s?.weeklyOff ?? null;
    await m.prisma.schoolSetting.updateMany({ data: { weeklyOff: { days: [0], saturdays: [] } } });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const range = { gte: d(`${Y}-04-01`), lte: d(`${Y + 1}-03-31`) };
    await prisma.employeeAttendance.deleteMany({ where: { date: range } });
    const types = await prisma.leaveType.findMany({ where: { code: { startsWith: tag } }, select: { id: true } });
    const typeIds = types.map((t) => t.id);
    await prisma.leaveRequest.deleteMany({ where: { leaveTypeId: { in: typeIds } } });
    await prisma.leaveBalance.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.leaveType.deleteMany({ where: { id: { in: typeIds } } });
    await prisma.holiday.deleteMany({ where: { date: range } });
    await prisma.attendancePeriodLock.deleteMany({ where: { month: range } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.schoolSetting.updateMany({
      data: { weeklyOff: weeklyOffBefore === null ? { days: [], saturdays: [] } : (weeklyOffBefore as object) },
    });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("marks a working day in one batch; times stored; audit has counts, no reason", async () => {
    const day = monday(5, 1);
    const r = await mark(hr, day, [entry(empT, { checkIn: "08:55", checkOut: "15:10" }), entry(empT2, { status: "ABSENT" })]);
    expect(r).toEqual({ created: 2, corrected: 0, unchanged: 0 });
    const a = await row(empT, day);
    expect(a).toMatchObject({ status: "PRESENT", source: "MANUAL", markedById: hr.userId, version: 1, leaveRequestId: null });
    expect(a!.checkIn!.toISOString().slice(11, 16)).toBe("08:55");
    expect((await row(empT2, day))!.status).toBe("ABSENT");
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "staff_attendance.mark", entityId: day }, orderBy: { at: "desc" } });
    expect(log.after).toMatchObject({ created: 2, corrected: 0, byStatus: { PRESENT: 1, ABSENT: 1 } });
  });

  it("re-saving is a no-op; a change needs a reason (L8) and the current version; reason never audited", async () => {
    const day = monday(5, 1, 1);
    await mark(hr, day, [entry(empT)]);
    const v1 = (await row(empT, day))!.version;
    expect(await mark(hr, day, [entry(empT, { version: v1 })])).toEqual({ created: 0, corrected: 0, unchanged: 1 });
    await expect(mark(hr, day, [entry(empT, { version: v1, status: "LATE" })])).rejects.toBeInstanceOf(m.ValidationError);
    await expect(mark(hr, day, [entry(empT, { version: v1 + 5, status: "LATE" })], "Synthetic SECRET-C")).rejects.toBeInstanceOf(m.ConflictError);
    await expect(mark(hr, day, [entry(empT, { version: null })], "Synthetic SECRET-C")).rejects.toBeInstanceOf(m.ConflictError);
    expect(await mark(hr, day, [entry(empT, { version: v1, status: "LATE", checkIn: "09:40" })], "Synthetic SECRET-C")).toEqual({
      created: 0, corrected: 1, unchanged: 0,
    });
    const a = await row(empT, day);
    expect(a).toMatchObject({ status: "LATE", correctionReason: "Synthetic SECRET-C", version: v1 + 1 });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "staff_attendance.correct", entityId: day } });
    expect(JSON.stringify(log)).not.toContain("SECRET-C");
    expect(log.after).toMatchObject({ corrections: [{ employeeId: empT, before: "PRESENT", after: "LATE" }] });
  });

  it("refuses weekly offs, staff holidays, future dates, dates outside a session, and locked months", async () => {
    await expect(mark(hr, monday(5, 2, -1), [entry(empT)])).rejects.toBeInstanceOf(m.ConflictError); // Sunday
    await m.createHoliday(hr, { date: monday(5, 2, 2), name: "Synthetic staff day", appliesTo: "STAFF" });
    await expect(mark(hr, monday(5, 2, 2), [entry(empT)])).rejects.toBeInstanceOf(m.ConflictError);
    await m.createHoliday(hr, { date: monday(5, 2, 3), name: "Synthetic pupils day", appliesTo: "STUDENTS" });
    expect((await mark(hr, monday(5, 2, 3), [entry(empT)])).created).toBe(1); // students-only holiday is a working day for staff
    await expect(mark(hr, "2999-01-07", [entry(empT)])).rejects.toBeInstanceOf(m.ValidationError);
    await expect(mark(hr, `${Y}-03-03`, [entry(empT)])).rejects.toBeInstanceOf(m.ValidationError); // before the session
    await m.prisma.attendancePeriodLock.create({ data: { month: d(`${Y}-07-01`) } });
    await expect(mark(hr, monday(7, 2), [entry(empT)])).rejects.toBeInstanceOf(m.ConflictError);
    expect(await row(empT, monday(7, 2))).toBeNull();
  });

  it("maker ≠ subject: own record refused (Super Admin too); unlinked marker refused; off-rolls employee refused", async () => {
    const day = monday(5, 3);
    await expect(mark(hr, day, [entry(empHr)])).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(mark(hr, day, [entry(empT), entry(empHr)])).rejects.toBeInstanceOf(m.ForbiddenError);
    expect(await row(empT, day)).toBeNull(); // whole batch refused
    await expect(mark(hrUnlinked, day, [entry(empT)])).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(mark(hr, monday(6, 1), [entry(empLate)])).rejects.toBeInstanceOf(m.ConflictError); // joins mid-June
    expect((await mark(hr, monday(6, 4), [entry(empLate)])).created).toBe(1);
    // Super Admin (unlinked here) may mark others.
    expect((await mark(superAdmin, day, [entry(empHr)])).created).toBe(1);
  });

  it("approved leave owns its days: marking them is refused", async () => {
    const t = await m.prisma.leaveType.create({
      data: { code: `${tag}CL`, name: `${run} CL`, nameKey: `${run} cl`, isPaid: true, annualQuota: 10, allowHalfDay: false, carryForwardMax: 0, appliesTo: "ALL" },
      select: { id: true },
    });
    await m.prisma.leaveBalance.create({ data: { employeeId: empT2, leaveTypeId: t.id, academicSessionId: sessionId, allotted: 5 } });
    const day = monday(8, 2);
    const req = await m.applyForLeave(teacher2, { leaveTypeId: t.id, fromDate: day, toDate: day, halfDay: null, reason: "Synthetic" });
    const v = (await m.prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.id } })).version;
    await m.decideLeave(principal, { id: req.id, version: v, decision: "APPROVE", note: "" });
    const leaveRow = await row(empT2, day);
    expect(leaveRow).toMatchObject({ status: "ON_LEAVE" });
    await expect(mark(hr, day, [entry(empT2, { version: leaveRow!.version })], "Synthetic")).rejects.toBeInstanceOf(m.ConflictError);
    const screen = await m.getAttendanceDay(hr, { date: day, departmentId: null });
    expect(screen.employees.find((e) => e.id === empT2)?.mark?.leaveCode).toBe(`${tag}CL`);
  });

  it("concurrency: two markers saving the same unmarked day — one wins, the other is told to reload", async () => {
    const day = monday(9, 1);
    const results = await Promise.allSettled([mark(hr, day, [entry(empT)]), mark(superAdmin, day, [entry(empT, { status: "ABSENT" })])]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(m.ConflictError);
    expect(await m.prisma.employeeAttendance.count({ where: { employeeId: empT, date: d(day) } })).toBe(1);
  });

  it("reads: SELF sees only the own month (with own correction reasons); register needs ALL", async () => {
    const month = monday(5, 1).slice(0, 7);
    const mine = await m.getMyAttendance(teacher, month);
    expect(mine.linked).toBe(true);
    if (!mine.linked) return;
    expect(mine.employee.id).toBe(empT);
    expect(mine.days.find((x) => x.date === monday(5, 1, 1))?.mark?.correctionReason).toBe("Synthetic SECRET-C");
    expect(mine.summary.late).toBe(1);
    await expect(m.getEmployeeAttendanceMonth(teacher, { employeeId: empT2, month })).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.getEmployeeAttendanceMonth(teacher, { employeeId: empT, month })).own).toBe(true);
    await expect(m.getAttendanceRegister(teacher, { month, departmentId: null, page: 1 })).rejects.toBeInstanceOf(m.ForbiddenError);
    const reg = await m.getAttendanceRegister(principal, { month, departmentId: null, page: 1 });
    expect(reg.total).toBeGreaterThan(0);
    // Principal holds personal tier → reasons visible; markers too.
    const pv = await m.getEmployeeAttendanceMonth(principal, { employeeId: empT, month });
    expect(pv.days.find((x) => x.date === monday(5, 1, 1))?.mark?.correctionReason).toBe("Synthetic SECRET-C");
    expect(pv.canMark).toBe(false);
  });

  it("M5 payroll summary: counts and LOP from real rows; Accountant exports CSV (audited), Principal can't export", async () => {
    const month = monday(5, 1).slice(0, 7);
    const page = await m.getPayrollAttendanceSummary(roleCtx.ACCOUNTANT, { month, departmentId: null, page: 1 });
    const t2 = page.items.find((e) => e.id === empT2)!;
    expect(t2.summary.absent).toBe(1); // marked absent on the first Monday of May
    expect(t2.summary.lopDays.toString()).toBe("1");
    expect(t2.summary.complete).toBe(false); // most May days are unmarked
    const t = page.items.find((e) => e.id === empT)!;
    expect(t.summary.late).toBe(1);
    const { csv, rows } = await m.exportPayrollAttendanceSummary(roleCtx.ACCOUNTANT, { month, departmentId: null });
    expect(rows).toBeGreaterThan(0);
    expect(csv).toContain("LOP days");
    expect(csv).not.toContain("SECRET-C");
    expect(await m.prisma.auditLog.count({ where: { action: "staff_attendance.summary_export", entityId: month, actorId: roleCtx.ACCOUNTANT.userId } })).toBe(1);
    await expect(m.exportPayrollAttendanceSummary(principal, { month, departmentId: null })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.getPayrollAttendanceSummary(teacher, { month, departmentId: null, page: 1 })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("RBAC over every role: only HR Manager and Super Admin mark; Parent and Student read nothing", async () => {
    const day = monday(10, 1);
    for (const [key, ctx] of Object.entries(roleCtx)) {
      const markResult = mark(ctx, day, [entry(empT2)]);
      if (key === "HR_MANAGER" || key === "SUPER_ADMIN") {
        await markResult;
        await m.prisma.employeeAttendance.deleteMany({ where: { employeeId: empT2, date: d(day) } });
      } else {
        await expect(markResult, key).rejects.toBeInstanceOf(m.ForbiddenError);
      }
      if (key === "HR_MANAGER" || key === "SUPER_ADMIN") await m.getAttendanceDay(ctx, { date: day, departmentId: null });
      else await expect(m.getAttendanceDay(ctx, { date: day, departmentId: null }), key).rejects.toBeInstanceOf(m.ForbiddenError);
      if (key === "PARENT" || key === "STUDENT") {
        await expect(m.getMyAttendance(ctx, day.slice(0, 7)), key).rejects.toBeInstanceOf(m.ForbiddenError);
        await expect(m.getEmployeeAttendanceMonth(ctx, { employeeId: empT, month: day.slice(0, 7) }), key).rejects.toBeInstanceOf(m.ForbiddenError);
      }
    }
  });
});
