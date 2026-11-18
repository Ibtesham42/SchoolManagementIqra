import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 3A M2 — HR core against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped
 * without TEST_DATABASE_URL). Real transactions, sequences, unique indexes, CHECKs, row locks, audit rows and
 * RBAC (PHASE_3_PLAN.md §10). Synthetic data only; everything created here is removed in afterAll except
 * audit rows (append-only by convention) and the shared employee-code counter rows.
 *
 * Needs the M2 catalog on Test (84 / 13 / 279). School Admin `employee.manage` is a new grant on an existing
 * role, which the seed core never adds by itself — ensureCatalog fails until the owner-approved grant exists.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/hr/master-data.service")),
  ...(await import("@/modules/hr/employees.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR core (integration)", () => {
  const run = `hr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, schoolAdmin: Ctx, librarian: Ctx, principal: Ctx, accountant: Ctx, teacher: Ctx;
  let deptId: string, inactiveDeptId: string, teachingDesigId: string, officeDesigId: string;
  const employeeIds: string[] = [];
  const startedAt = new Date();

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const base = (over: Record<string, unknown> = {}) => ({
    firstName: "Synthetic",
    middleName: null,
    lastName: `Staff ${run}`,
    dob: "1985-04-10",
    gender: "FEMALE" as const,
    personalPhone: "9876500001",
    workPhone: null,
    personalEmail: null,
    workEmail: null,
    address: null,
    emergencyContact: null,
    departmentId: deptId,
    designationId: teachingDesigId,
    appointmentType: "PERMANENT" as const,
    joiningDate: "2026-06-01",
    confirmationDate: null,
    reportsToId: null,
    ...over,
  });
  async function register(over: Record<string, unknown> = {}) {
    const r = await m.registerEmployee(hr, base(over) as Parameters<typeof m.registerEmployee>[1]);
    employeeIds.push(r.id);
    return r;
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, sa, lib, pr, acc, t] = await Promise.all([user("hr", "HR_MANAGER"), user("sa", "SCHOOL_ADMIN"), user("lib", "LIBRARIAN"), user("pr", "PRINCIPAL"), user("acc", "ACCOUNTANT"), user("t", "TEACHER")]);
    [hr, schoolAdmin, librarian, principal, accountant, teacher] = await Promise.all([h, sa, lib, pr, acc, t].map((u) => ctxFor(u.id)));
    deptId = (await m.createDepartment(hr, { code: `${tag}-SCI`, name: `${run} Science` }))!.id;
    inactiveDeptId = (await m.createDepartment(hr, { code: `${tag}-OLD`, name: `${run} Old` }))!.id;
    await m.setDepartmentActive(hr, { id: inactiveDeptId, version: 1, active: false });
    teachingDesigId = (await m.createDesignation(hr, { code: `${tag}-TGT`, name: `${run} TGT`, staffType: "TEACHING" }))!.id;
    officeDesigId = (await m.createDesignation(hr, { code: `${tag}-CLK`, name: `${run} Clerk`, staffType: "NON_TEACHING" }))!.id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (prisma) {
      await prisma.employeeServiceEvent.deleteMany({ where: { employeeId: { in: employeeIds } } });
      // reports-to references first (RESTRICT), then the employees.
      await prisma.employee.updateMany({ where: { id: { in: employeeIds } }, data: { reportsToId: null } });
      await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
      await prisma.designation.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
      await prisma.department.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
      await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
      await prisma.$disconnect();
    }
  }, 120_000);

  it("registration: permanent code from the joining year, staff type from the designation, JOINED event, audit without personal data", async () => {
    const r = await register({ personalEmail: "synthetic@example.invalid", address: { line1: "1 Demo Road", line2: null, city: "Demo City", district: null, state: "Demo State", pinCode: "793001", country: "India" } });
    expect(r.employeeCode).toMatch(/^EMP-2026-\d{4,}$/);
    const row = await m.prisma.employee.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ staffType: "TEACHING", employmentStatus: "ACTIVE", fullName: `Synthetic Staff ${run}`, version: 1 });
    const events = await m.prisma.employeeServiceEvent.findMany({ where: { employeeId: r.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: "JOINED", actedById: hr.userId });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.create", entityId: r.id } });
    const text = JSON.stringify({ action: log.action, before: log.before, after: log.after }); // id is a BigInt
    for (const secret of ["Synthetic", "9876500001", "synthetic@example.invalid", "1985-04-10", "Demo Road"]) expect(text, secret).not.toContain(secret);
    expect(text).toContain(r.employeeCode);
  });

  it("20 parallel registrations get 20 distinct, gap-free codes", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => register({ personalPhone: `98765${String(10000 + i).slice(1)}`, designationId: officeDesigId })));
    const seqs = results.map((r) => Number(r.employeeCode.split("-")[2])).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(20);
    expect(seqs[19] - seqs[0]).toBe(19);
    for (const r of results) expect(await m.prisma.employee.findUniqueOrThrow({ where: { id: r.id }, select: { staffType: true } })).toEqual({ staffType: "NON_TEACHING" });
  }, 300_000);

  it("refuses inactive master data, a leaver as manager and impossible dates — nothing written, no code consumed", async () => {
    const before = await m.prisma.employee.count();
    await expect(register({ departmentId: inactiveDeptId })).rejects.toMatchObject({ details: [{ path: "departmentId" }] });
    const leaver = await register();
    await m.prisma.employee.update({ where: { id: leaver.id }, data: { employmentStatus: "RESIGNED", leavingDate: new Date("2026-09-01T00:00:00.000Z"), leavingReason: "Synthetic" } });
    await expect(register({ reportsToId: leaver.id })).rejects.toMatchObject({ details: [{ path: "reportsToId" }] });
    await expect(register({ dob: "2026-06-01" })).rejects.toBeInstanceOf(m.ValidationError);
    expect(await m.prisma.employee.count()).toBe(before + 1);
    const next = await register();
    expect(Number(next.employeeCode.split("-")[2])).toBe(Number(leaver.employeeCode.split("-")[2]) + 1);
  });

  it("tiers: Librarian sees directory fields only; Principal sees personal details; Accountant and Teacher get 403", async () => {
    const r = await register({ personalEmail: "tier@example.invalid" });
    const dir = await m.getEmployee(librarian, r.id);
    expect(dir.tier).toBe("directory");
    expect(dir).not.toHaveProperty("dob");
    expect(dir).not.toHaveProperty("personalPhone");
    expect(dir).not.toHaveProperty("address");
    const full = await m.getEmployee(principal, r.id);
    expect(full).toMatchObject({ tier: "personal", personalEmail: "tier@example.invalid" });
    for (const ctx of [accountant, teacher]) {
      await expect(m.getEmployee(ctx, r.id)).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.listEmployees(ctx, { page: 1, pageSize: 25 })).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.registerEmployee(ctx, base() as Parameters<typeof m.registerEmployee>[1])).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.createDepartment(ctx, { code: `${tag}-X`, name: `${run} X` })).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    await expect(m.getEmployee(principal, "missing-id")).rejects.toBeInstanceOf(m.NotFoundError);
  });

  it("directory search: name and code for everyone; personal phone only for the personal tier", async () => {
    const r = await register({ personalPhone: "9876512345", lastName: `Searchable ${run}` });
    const byName = await m.listEmployees(librarian, { q: `searchable ${run}`, page: 1, pageSize: 25 });
    expect(byName.rows.map((x) => x.id)).toEqual([r.id]);
    expect(byName.rows[0]).not.toHaveProperty("personalPhone");
    expect((await m.listEmployees(librarian, { q: r.employeeCode, page: 1, pageSize: 25 })).rows.map((x) => x.id)).toEqual([r.id]);
    expect((await m.listEmployees(librarian, { q: "98765 12345", page: 1, pageSize: 25 })).total).toBe(0);
    expect((await m.listEmployees(hr, { q: "98765 12345", page: 1, pageSize: 25 })).rows.map((x) => x.id)).toEqual([r.id]);
  });

  it("field-level edits: version conflicts refused, names re-normalized, audit redacted; School Admin may edit (Q1)", async () => {
    const r = await register();
    await m.updateEmployeePersonal(schoolAdmin, { id: r.id, version: 1, firstName: "Renamed", middleName: null, lastName: `Staff ${run}`, dob: "1986-01-01", gender: "FEMALE" });
    const row = await m.prisma.employee.findUniqueOrThrow({ where: { id: r.id } });
    expect(row).toMatchObject({ version: 2, fullName: `Renamed Staff ${run}`, fullNameNormalized: `renamed staff ${run}` });
    await expect(m.updateEmployeePersonal(hr, { id: r.id, version: 1, firstName: "Stale", middleName: null, lastName: null, dob: "1986-01-01", gender: "FEMALE" })).rejects.toBeInstanceOf(m.ConflictError);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.update_personal", entityId: r.id } });
    expect(JSON.stringify({ before: log.before, after: log.after })).not.toContain("Renamed");
    expect(log.after).toMatchObject({ firstName: "[REDACTED]", dob: "[REDACTED]", version: 2 });
    await m.updateEmployeeContact(hr, { id: r.id, version: 2, personalPhone: "9876500009", workPhone: null, personalEmail: null, workEmail: "work@example.invalid", address: null, emergencyContact: { name: "Synthetic Contact", relation: "Spouse", phone: "9123456780" } });
    expect(await m.prisma.employee.findUniqueOrThrow({ where: { id: r.id }, select: { version: true, workEmail: true } })).toEqual({ version: 3, workEmail: "work@example.invalid" });
    await expect(m.updateEmployeePersonal(librarian, { id: r.id, version: 3, firstName: "X", middleName: null, lastName: null, dob: "1986-01-01", gender: "FEMALE" })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("master data: Unicode names unique by key (composed = decomposed), codes and staff type fixed once used, deactivate", async () => {
    await m.createDepartment(hr, { code: `${tag}-HIN`, name: `${run} क़ानून` });
    await expect(m.createDepartment(hr, { code: `${tag}-HIN2`, name: `${run} क़ानून` })).rejects.toThrow(/already exists/);
    await expect(m.createDepartment(hr, { code: `${tag}-SCI`, name: `${run} Other` })).rejects.toThrow(/code/);
    const desig = (await m.listDesignations(hr, { includeInactive: true })).find((d) => d.id === teachingDesigId)!;
    await expect(m.updateDesignation(hr, { id: teachingDesigId, version: desig.version, code: desig.code, name: desig.name, staffType: "NON_TEACHING" })).rejects.toThrow(/staff type/);
    const dept = (await m.listDepartments(hr)).find((d) => d.id === deptId)!;
    await expect(m.updateDepartment(hr, { id: deptId, version: dept.version, code: `${tag}-SC2`, name: dept.name })).rejects.toThrow(/code can't change/);
    await m.updateDepartment(hr, { id: deptId, version: dept.version, code: dept.code, name: `${run} Sciences` });
    expect((await m.listDepartments(librarian)).find((d) => d.id === deptId)?.name).toBe(`${run} Sciences`);
  });

  it("database CHECKs back the service rules (a direct write can't bypass them)", async () => {
    const r = await register();
    await expect(m.prisma.employee.update({ where: { id: r.id }, data: { employmentStatus: "RETIRED" } })).rejects.toThrow(); // leaving status needs a date + reason
    await expect(m.prisma.employee.update({ where: { id: r.id }, data: { reportsToId: r.id } })).rejects.toThrow(); // no self-reporting
    await expect(m.prisma.department.create({ data: { code: `${tag}-ZW`, name: "Sci​ence", nameKey: "science-zw" } })).rejects.toThrow(); // zero-width space
  });

  it("writes nothing outside this run's rows", async () => {
    const touched = await m.prisma.auditLog.findMany({ where: { at: { gte: startedAt }, entityType: { in: ["Employee", "Department", "Designation"] } }, select: { entityId: true } });
    const own = new Set([...employeeIds, deptId, inactiveDeptId, teachingDesigId, officeDesigId]);
    const ownDepts = (await m.prisma.department.findMany({ where: { code: { startsWith: `${tag}-` } }, select: { id: true } })).map((d) => d.id);
    for (const id of ownDepts) own.add(id);
    expect(touched.filter((t) => !own.has(t.entityId ?? ""))).toEqual([]);
  });
});
