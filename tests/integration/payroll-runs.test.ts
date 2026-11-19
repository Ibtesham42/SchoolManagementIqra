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
  ...(await import("@/modules/payroll/slips.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("payroll runs (integration)", () => {
  const run = `pr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 1950 + Math.floor(Math.random() * 40);
  const MONTH = `${Y}-03`;
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, principal: Ctx, accountant: Ctx, superAdmin: Ctx, teacherA: Ctx;
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
    superAdmin = await ctxOf((await user("sa", "SUPER_ADMIN")).id);
    teacherA = await ctxOf(ta.id);
    structureId = (await m.prisma.salaryStructure.create({ data: { name: `${run} Basic only`, nameKey: `${run} basic only` } })).id;
    const s = await m.prisma.schoolSetting.findFirst({ select: { weeklyOff: true, payrollDayBasis: true } });
    settingsBefore = s ? { weeklyOff: s.weeklyOff, payrollDayBasis: s.payrollDayBasis } : null;
    await m.prisma.schoolSetting.updateMany({ data: { weeklyOff: { days: [0], saturdays: [] }, payrollDayBasis: null } });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.attendancePeriodLock.deleteMany({ where: { month: d(`${MONTH}-01`) } });
    const runs = await prisma.payrollRun.findMany({ where: { month: d(`${MONTH}-01`) }, select: { id: true } });
    await prisma.salaryPayment.deleteMany({ where: { slip: { runId: { in: runs.map((r) => r.id) } } } });
    await prisma.payrollAdjustment.deleteMany({ where: { slip: { runId: { in: runs.map((r) => r.id) } } } });
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

  it("3C-M4: approval refuses the preparer and stale runs; numbers slips and locks the month; reopen keeps the numbers", async () => {
    let r = (await m.listRuns(accountant)).find((x) => x.month.toISOString().startsWith(MONTH))!;
    // Super Admin prepares → can't approve their own preparation.
    await m.prepareRun(superAdmin, { id: r.id, version: r.version });
    r = (await m.listRuns(accountant)).find((x) => x.id === r.id)!;
    await expect(m.approveRun(superAdmin, { id: r.id, version: r.version })).rejects.toThrow(/You prepared this payroll/);
    // An attendance correction after preparing → approval refused until prepared again.
    await m.prisma.employeeAttendance.updateMany({ where: { employeeId: empA, date: d(`${MONTH}-07`) }, data: { status: "PRESENT" } });
    await expect(m.approveRun(principal, { id: r.id, version: r.version })).rejects.toThrow(/changed since this payroll was prepared/);
    await m.prepareRun(accountant, { id: r.id, version: r.version });
    r = (await m.listRuns(accountant)).find((x) => x.id === r.id)!;
    expect(await m.approveRun(principal, { id: r.id, version: r.version })).toEqual({ slips: 2 });
    const approved = await m.getRun(principal, r.id);
    expect(approved.status).toBe("APPROVED");
    const numbers = approved.slips.map((s) => s.slipNo);
    expect(numbers.every((n) => typeof n === "string" && n.startsWith(`SLIP-${Y}-`))).toBe(true);
    expect(new Set(numbers).size).toBe(2);
    expect(await m.prisma.attendancePeriodLock.count({ where: { month: d(`${MONTH}-01`) } })).toBe(1);
    await expect(m.prepareRun(accountant, { id: r.id, version: approved.version })).rejects.toThrow(/already approved/);
    // A salary into an approved month is refused (payroll lock + final month check).
    await expect(m.proposeSalary(hr, { employeeId: empA, structureId, basic: "35000", effectiveFrom: MONTH })).rejects.toThrow(/already approved/);
    // Reopen: reason required (schema), month unlocked, slip numbers kept.
    await m.reopenRun(principal, { id: r.id, version: approved.version, reason: "Synthetic correction" });
    expect(await m.prisma.attendancePeriodLock.count({ where: { month: d(`${MONTH}-01`) } })).toBe(0);
    const reopened = await m.getRun(principal, r.id);
    expect(reopened.status).toBe("PREPARED");
    expect(reopened.slips.map((s) => s.slipNo).sort()).toEqual([...numbers].sort());
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "payroll_run.reopen", entityId: r.id } });
    expect(log.after).toMatchObject({ reasonGiven: true });
    expect(JSON.stringify(log)).not.toContain("Synthetic correction"); // free text stays out of audit rows (review L3)
  });

  it("3C-M5: an adjustment needs a re-prepare before approval; payments can't exceed the net; the run is PAID when every slip is paid", async () => {
    let r = (await m.listRuns(accountant)).find((x) => x.month.toISOString().startsWith(MONTH))!; // PREPARED after the reopen
    const slipA = (await m.getRun(accountant, r.id)).slips.find((s) => s.employee.id === empA)!;
    const grossBefore = Number(slipA.gross);
    await m.addAdjustment(hr, { slipId: slipA.id, kind: "BONUS", amount: "1000", note: "Synthetic bonus" });
    await expect(m.approveRun(principal, { id: r.id, version: r.version })).rejects.toThrow(/changed since this payroll was prepared/);
    await m.prepareRun(accountant, { id: r.id, version: r.version });
    r = (await m.listRuns(accountant)).find((x) => x.id === r.id)!;
    const after = (await m.getRun(accountant, r.id)).slips.find((s) => s.employee.id === empA)!;
    expect(Number(after.gross)).toBe(grossBefore + 1000);
    await m.approveRun(principal, { id: r.id, version: r.version });
    await expect(m.addAdjustment(hr, { slipId: slipA.id, kind: "BONUS", amount: "1", note: "Too late" })).rejects.toThrow(/prepared \(not yet approved\)/);

    const net = Number(after.net);
    await expect(m.recordPayment(accountant, { slipId: after.id, amount: (net + 1).toFixed(2), method: "BANK_TRANSFER", reference: `${tag}UTR1`, paidOn: "2026-01-02" })).rejects.toThrow(/still due/);
    await m.recordPayment(accountant, { slipId: after.id, amount: "100.00", method: "BANK_TRANSFER", reference: `${tag}UTR1`, paidOn: "2026-01-02" });
    await expect(m.recordPayment(accountant, { slipId: after.id, amount: "1.00", method: "BANK_TRANSFER", reference: `${tag}UTR1`, paidOn: "2026-01-02" })).rejects.toThrow(/already recorded/);
    const bulk = await m.recordBulkPayment(accountant, { runId: r.id, method: "BANK_TRANSFER", reference: `${tag}BATCH`, paidOn: "2026-01-03" });
    expect(bulk).toMatchObject({ slips: 2, runPaid: true });
    const paid = await m.getRun(accountant, r.id);
    expect(paid.status).toBe("PAID");
    await expect(m.reopenRun(principal, { id: r.id, version: paid.version, reason: "Synthetic" })).rejects.toThrow(/payments/);
    const logs = await m.prisma.auditLog.findMany({ where: { action: { startsWith: "salary_payment" } , entityId: { in: [after.id, r.id] } } });
    expect(JSON.stringify(logs)).not.toMatch(/UTR1|BATCH|Synthetic bonus/);

    // My salary slips: the teacher sees their own slip, not another's.
    const mine = await m.listMySlips(teacherA);
    expect(mine.linked && mine.slips.map((s) => s.id)).toEqual([after.id]);
    const other = paid.slips.find((s) => s.employee.id === empB)!;
    await expect(m.getSlip(teacherA, other.id)).rejects.toBeInstanceOf(m.NotFoundError);
    expect((await m.getSlip(teacherA, after.id)).own).toBe(true);
  });
});
