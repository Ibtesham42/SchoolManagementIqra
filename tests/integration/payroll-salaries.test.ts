import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3C-M2 employee salaries (maker-checker, P7) against real Postgres (Neon Test branch only, behind the S-05
 * target guard; skipped without TEST_DATABASE_URL). Real partial unique indexes, CHECKs, locks, versions and audit rows.
 * Synthetic data; payroll runs in far-future months; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/payroll/salaries.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("payroll employee salaries (integration)", () => {
  const run = `sl${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, principal: Ctx, accountant: Ctx;
  let empHr: string, empP: string, empT: string, structureId: string;

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const ctxOf = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, p, a, t] = [await user("hr", "HR_MANAGER"), await user("pr", "PRINCIPAL"), await user("acc", "ACCOUNTANT"), await user("t", "TEACHER")];
    empHr = await linkTeachingEmployee(m.prisma, tag, h.id, { staffType: "NON_TEACHING" });
    empP = await linkTeachingEmployee(m.prisma, tag, p.id);
    await linkTeachingEmployee(m.prisma, tag, a.id, { staffType: "NON_TEACHING" });
    empT = await linkTeachingEmployee(m.prisma, tag, t.id);
    [hr, principal, accountant] = [await ctxOf(h.id), await ctxOf(p.id), await ctxOf(a.id)];
    structureId = (await m.prisma.salaryStructure.create({ data: { name: `${run} Teaching`, nameKey: `${run} teaching` } })).id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.payrollRun.deleteMany({ where: { month: { gte: new Date(`${Y}-01-01`), lte: new Date(`${Y}-12-01`) } } });
    await prisma.employeeSalary.deleteMany({ where: { structureId } });
    await prisma.salaryStructure.deleteMany({ where: { id: structureId } });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("HR proposes, the Principal approves; one pending proposal per employee; audit never holds the amount", async () => {
    const p = await m.proposeSalary(hr, { employeeId: empT, structureId, basic: "30000.50", effectiveFrom: `${Y}-04` });
    await expect(m.proposeSalary(hr, { employeeId: empT, structureId, basic: "31000", effectiveFrom: `${Y}-05` })).rejects.toThrow(/pending proposal/);
    const pending = await m.listPendingSalaries(principal);
    const row = pending.find((x) => x.id === p.id)!;
    expect(row.basic.toFixed(2)).toBe("30000.50");
    await m.decideSalary(principal, { id: p.id, version: row.version, decision: "APPROVE", note: "" });
    const history = (await m.getEmployeeSalaries(accountant, empT)).history;
    expect(history[0]).toMatchObject({ status: "APPROVED" });
    const logs = await m.prisma.auditLog.findMany({ where: { entityId: p.id } });
    expect(logs.map((l) => l.action).sort()).toEqual(["employee_salary.approve", "employee_salary.propose"]);
    expect(JSON.stringify(logs)).not.toContain("30000");
  });

  it("separation of duties: own salary refused for proposer and approver; a decided proposal can't be decided again", async () => {
    await expect(m.proposeSalary(hr, { employeeId: empHr, structureId, basic: "40000", effectiveFrom: `${Y}-04` })).rejects.toThrow(/your own salary/);
    const p = await m.proposeSalary(hr, { employeeId: empP, structureId, basic: "50000", effectiveFrom: `${Y}-04` });
    await expect(m.decideSalary(principal, { id: p.id, version: 1, decision: "APPROVE", note: "" })).rejects.toThrow(/your own salary/);
    await expect(m.listPendingSalaries(principal)).resolves.not.toContainEqual(expect.objectContaining({ id: p.id }));
    await m.withdrawSalary(hr, { id: p.id, version: 1 });
    await expect(m.decideSalary(principal, { id: p.id, version: 2, decision: "APPROVE", note: "" })).rejects.toThrow(/your own salary|already been decided/);
  });

  it("a rejection keeps the note; one approved salary per employee and month; months with an approved payroll are closed", async () => {
    const p = await m.proposeSalary(hr, { employeeId: empT, structureId, basic: "32000", effectiveFrom: `${Y}-04` });
    await expect(m.decideSalary(principal, { id: p.id, version: 1, decision: "APPROVE", note: "" })).rejects.toThrow(/approved salary from that month/);
    await m.decideSalary(principal, { id: p.id, version: 1, decision: "REJECT", note: "Synthetic: same month as current" });
    expect((await m.getEmployeeSalaries(hr, empT)).history.find((h) => h.id === p.id)).toMatchObject({ status: "REJECTED", decisionNote: "Synthetic: same month as current" });
    await m.prisma.payrollRun.create({ data: { month: new Date(`${Y}-06-01`), status: "APPROVED", dayBasis: "WORKING_DAYS", preparedAt: new Date(), approvedAt: new Date() } });
    await expect(m.proposeSalary(hr, { employeeId: empT, structureId, basic: "33000", effectiveFrom: `${Y}-05` })).rejects.toThrow(/already approved/);
    expect((await m.proposeSalary(hr, { employeeId: empT, structureId, basic: "33000", effectiveFrom: `${Y}-07` })).id).toBeTruthy();
  });

  it("the database refuses a salary from mid-month and a negative basic (past the service)", async () => {
    await expect(m.prisma.employeeSalary.create({ data: { employeeId: empT, structureId, basic: 1, effectiveFrom: new Date(`${Y}-08-15`), status: "WITHDRAWN" } })).rejects.toThrow();
    await expect(m.prisma.employeeSalary.create({ data: { employeeId: empT, structureId, basic: -1, effectiveFrom: new Date(`${Y}-08-01`), status: "WITHDRAWN" } })).rejects.toThrow();
  });
});
