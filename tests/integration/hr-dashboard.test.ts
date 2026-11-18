import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 3A M5 — HR dashboard and directory export against real Postgres (Test branch only, behind the S-05 guard;
 * skipped without TEST_DATABASE_URL). Synthetic data only; removed in afterAll except audit rows and shared
 * counter rows. Needs the Phase 3A catalog on Test (KI-062).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/identity/super-admin-guard")),
  ...(await import("@/modules/hr/master-data.service")),
  ...(await import("@/modules/hr/employees.service")),
  ...(await import("@/modules/hr/staff-accounts.service")),
  ...(await import("@/modules/hr/hr-dashboard.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR dashboard and export (integration)", () => {
  const run = `hd${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, hr: Ctx, librarian: Ctx;
  let dept: string;
  const employeeIds: string[] = [];

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.$transaction(async (tx) => {
      if (roleKey === "SUPER_ADMIN") await m.lockSuperAdminGuard(tx);
      return tx.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
    });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [r, h, lib] = await Promise.all([user("root", "SUPER_ADMIN"), user("hr", "HR_MANAGER"), user("lib", "LIBRARIAN")]);
    [root, hr, librarian] = await Promise.all([r, h, lib].map((u) => ctxFor(u.id)));
    dept = (await m.createDepartment(hr, { code: `${tag}-D`, name: `${run} Dept` }))!.id;
    const tgt = (await m.createDesignation(hr, { code: `${tag}-T`, name: `${run} TGT`, staffType: "TEACHING" }))!.id;
    for (let i = 0; i < 3; i++) {
      const { id } = await m.registerEmployee(hr, {
        firstName: i === 2 ? "=HYPERLINK(1)" : "Synthetic",
        middleName: null,
        lastName: `Dash ${run} ${i}`,
        dob: "1982-02-02",
        gender: "MALE",
        personalPhone: `94567${String(10000 + i).slice(1)}`,
        workPhone: null,
        personalEmail: `personal${i}@example.invalid`,
        workEmail: null,
        address: null,
        emergencyContact: null,
        departmentId: dept,
        designationId: tgt,
        appointmentType: "CONTRACT",
        joiningDate: "2026-07-01",
        confirmationDate: null,
        reportsToId: null,
      }); // "=HYPERLINK(1)" would be refused by the form schema; calling the service directly proves the CSV neutralises it.
      employeeIds.push(id);
    }
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.employeeServiceEvent.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await prisma.designation.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.department.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.$transaction(async (tx) => {
      await m.lockSuperAdminGuard(tx);
      await tx.user.deleteMany({ where: { username: { startsWith: run } } });
    });
    await prisma.$disconnect();
  }, 120_000);

  it("dashboard blocks follow permissions: Librarian aggregates only; HR also joiners/leavers; Super Admin everything", async () => {
    const lib = await m.hrDashboard(librarian);
    expect(lib.tier).toBe("directory");
    expect([lib.joiners, lib.leavers, lib.withoutLogin, lib.teachersWithoutSection]).toEqual([null, null, null, null]);
    expect(lib.perDepartment.find((d) => d.id === dept)?.count).toBe(3);
    const h = await m.hrDashboard(hr);
    expect(h.joiners?.length).toBeGreaterThan(0);
    expect(h.withoutLogin).toBeNull(); // HR Manager has no user.read
    const sa = await m.hrDashboard(root);
    expect(sa.withoutLogin?.total).toBeGreaterThanOrEqual(3);
    expect(sa.teachersWithoutSection).not.toBeNull();
  });

  it("export: directory fields only, formulas neutralised, audit holds filter names and row count only", async () => {
    const { csv, rows } = await m.exportEmployeeRows(hr, { departmentId: dept, q: `dash ${run}` });
    expect(rows).toBe(3);
    expect(csv.split("\r\n")[0]).toBe("﻿Employee ID,Name,Staff type,Designation,Department,Status,Work phone,Work email");
    expect(csv).not.toMatch(/personal\d@example\.invalid|94567|1982-02-02|Contract/);
    expect(csv).toContain("'=HYPERLINK(1)");
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.export", actorId: hr.userId }, orderBy: { at: "desc" } });
    expect(log.after).toEqual({ filters: ["departmentId", "q"], rows: 3, format: "csv" });
    await expect(m.exportEmployeeRows(librarian, {})).rejects.toBeInstanceOf(m.ForbiddenError); // no export.run
  });
});
