import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3C-M3 payroll runs against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped without
 * TEST_DATABASE_URL). A run must be for a finished month with complete attendance, so this suite uses a random month in
 * 1950–1989 and fixture staff who "joined" in 1941 (no real or other-suite employee is on the rolls then). Attendance
 * rows are written directly (fixture); salaries go through the real propose → approve flow. Golden values by hand.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/payroll/runs.service")),
  ...(await import("@/modules/payroll/salaries.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("payroll runs (integration)", () => {
  const run = `pr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 1950 + Math.floor(Math.random() * 40);
  const MONTH = `${Y}-03`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, principal: Ctx, accountant: Ctx;
  let empA: string, empB: string, structureId: string;
  let settingsBefore: { weeklyOff: unknown; payrollDayBasis: string | null } | null = null;
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const ctxOf = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;
  /** Every working day of the month (Sundays off) → PRESENT, except the dates given. */
  async function attendance(employeeId: string, except: Record<string, "ABSENT"> = {}, skip: string[] = []) {
    const rows = [];
    for (let day = 1; day <= 31; day += 1) {
      const date = `${MONTH}-${String(day).padStart(2, "0")}`;
      if (d(date).getUTCDay() === 0 || skip.includes(date)) continue;
      rows.push({ employeeId, date: d(date), status: except[date] ?? ("PRESENT" as const) });
    }
    await m.prisma.employeeAttendance.createMany({ data: rows });
    return rows.length;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, p, a, ta, tb] = [await user("hr", "HR_MANAGER"), await user("pr", "PRINCIPAL"), await user("acc", "ACCOUNTANT"), await user("ta", "TEACHER"), await user("tb", "TEACHER")];
    await linkTeachingEmployee(m.prisma, tag, h.id, { staffType: "NON_TEACHING" });
    await linkTeachingEmployee(m.prisma, tag, p.id);
    await linkTeachingEmployee(m.prisma, tag, a.id, { staffType: "NON_TEACHING" });
    empA = await linkTeachingEmployee(m.prisma, tag, ta.id);
    empB = await linkTeachingEmployee(m.prisma, tag, tb.id);
    await m.prisma.employee.updateMany({ where: { id: { in: [empA, empB] } }, data: { dob: d("1940-01-01"), joiningDate: d("1941-01-01") } });
    [hr, principal, accountant] = [await ctxOf(h.id), await ctxOf(p.id), await ctxOf(a.id)];
    structureId = (await m.prisma.salaryStructure.create({ data: { name: `${run} Basic only`, nameKey: `${run} basic only` } })).id;
    const s = await m.prisma.schoolSetting.findFirst({ select: { weeklyOff: true, payrollDayBasis: true } });
    settingsBefore = s ? { weeklyOff: s.weeklyOff, payrollDayBasis: s.payrollDayBasis } : null;
    await m.prisma.schoolSetting.updateMany({ data: { weeklyOff: { days: [0], saturdays: [] }, payrollDayBasis: null } });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const runs = await prisma.payrollRun.findMany({ where: { month: d(`${MONTH}-01`) }, select: { id: true } });
    await prisma.payrollSlip.deleteMany({ where: { runId: { in: runs.map((r) => r.id) } } });
    await prisma.payrollRun.deleteMany({ where: { id: { in: runs.map((r) => r.id) } } });
    await prisma.employeeAttendance.deleteMany({ where: { employeeId: { in: [empA, empB].filter(Boolean) } } });
    await prisma.employeeSalary.deleteMany({ where: { structureId } });
    await prisma.salaryStructure.deleteMany({ where: { id: structureId } });
    if (settingsBefore) {
      await prisma.schoolSetting.updateMany({
        data: { weeklyOff: (settingsBefore.weeklyOff ?? { days: [], saturdays: [] }) as object, payrollDayBasis: settingsBefore.payrollDayBasis as "WORKING_DAYS" | "CALENDAR_DAYS" | null },
      });
    }
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("creates one run per month; never for a future month", async () => {
    await m.createRun(accountant, { month: MONTH });
    await expect(m.createRun(accountant, { month: MONTH })).rejects.toThrow(/already exists/);
    await expect(m.createRun(accountant, { month: "2999-01" })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.createRun(principal, { month: MONTH })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("prepare refuses until the basis is set (P3) and while attendance is incomplete (P4)", async () => {
    const r = (await m.listRuns(accountant)).find((x) => x.month.toISOString().startsWith(MONTH))!;
    await expect(m.prepareRun(accountant, { id: r.id, version: r.version })).rejects.toThrow(/working days or calendar days/);
    await m.prisma.schoolSetting.updateMany({ data: { payrollDayBasis: "WORKING_DAYS" } });
    await attendance(empA, { [`${MONTH}-07`]: "ABSENT" });
    await attendance(empB, {}, [`${MONTH}-15`]); // one working day left unmarked
    await expect(m.prepareRun(accountant, { id: r.id, version: r.version })).rejects.toThrow(/isn't complete for 1 staff/);
    await m.prisma.employeeAttendance.create({ data: { employeeId: empB, date: d(`${MONTH}-15`), status: "PRESENT" } });
  });

  it("prepares snapshot slips from approved salaries; staff without one are listed; amounts never audited", async () => {
    // March: 31 days, Sundays off. Working days = 31 − Sundays.
    let working = 0;
    for (let day = 1; day <= 31; day += 1) if (d(`${MONTH}-${String(day).padStart(2, "0")}`).getUTCDay() !== 0) working += 1;
    const pa = await m.proposeSalary(hr, { employeeId: empA, structureId, basic: "31000", effectiveFrom: MONTH });
    await m.decideSalary(principal, { id: pa.id, version: 1, decision: "APPROVE", note: "" });
    const r = (await m.listRuns(accountant)).find((x) => x.month.toISOString().startsWith(MONTH))!;
    const res = await m.prepareRun(accountant, { id: r.id, version: r.version });
    expect(res.slips).toBe(1);
    expect(res.withoutSalary.map((e) => e.fullName)).toHaveLength(1); // empB has no salary yet
    const full = await m.getRun(accountant, r.id);
    expect(full).toMatchObject({ status: "PREPARED", dayBasis: "WORKING_DAYS", employeeCount: 1 });
    const slip = full.slips[0];
    expect([slip.monthDays, slip.offRollsDays, slip.lopDays.toString(), slip.paidDays.toString()]).toEqual([working, 0, "1", String(working - 1)]);
    // 31000 × (working − 1) / working, half-up to 2 dp.
    const expected = Math.round((31000 * (working - 1) * 100) / working) / 100;
    expect(slip.net.toFixed(2)).toBe(expected.toFixed(2));
    const logs = await m.prisma.auditLog.findMany({ where: { entityId: r.id } });
    expect(JSON.stringify(logs)).not.toMatch(/31000|29\d{3}\./);
  });

  it("re-prepare picks up a newly approved salary and refuses a stale screen; totals reconcile", async () => {
    const pb = await m.proposeSalary(hr, { employeeId: empB, structureId, basic: "27000", effectiveFrom: MONTH });
    await m.decideSalary(principal, { id: pb.id, version: 1, decision: "APPROVE", note: "" });
    const r = (await m.listRuns(accountant)).find((x) => x.month.toISOString().startsWith(MONTH))!;
    await expect(m.prepareRun(accountant, { id: r.id, version: r.version - 1 })).rejects.toThrow(/changed by someone else/);
    expect((await m.prepareRun(accountant, { id: r.id, version: r.version })).slips).toBe(2);
    const full = await m.getRun(accountant, r.id);
    expect(full.slips.find((s) => s.employee.id === empB)!.net.toFixed(2)).toBe("27000.00"); // full month, no LOP
    expect(full.totalNet.toFixed(2)).toBe(full.slips.reduce((t, s) => t + Number(s.net), 0).toFixed(2));
  });
});
