import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 3A M4a — employment lifecycle against real Postgres (Test branch only, behind the S-05 guard; skipped
 * without TEST_DATABASE_URL): employment events, reporting cycles under concurrency, leaving (class-teacher
 * release + optional account deactivation, all-or-nothing), rejoining, history tiers. Synthetic data only; removed
 * in afterAll except audit rows and shared counter rows. Needs the Phase 3A catalog on Test (KI-062).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/identity/super-admin-guard")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/hr/master-data.service")),
  ...(await import("@/modules/hr/employees.service")),
  ...(await import("@/modules/hr/staff-accounts.service")),
  ...(await import("@/modules/hr/employee-lifecycle.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR employment lifecycle (integration)", () => {
  const run = `hl${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2400 + Math.floor(Math.random() * 400);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, hr: Ctx, librarian: Ctx;
  let dept1: string, dept2: string, tgt: string, pgt: string, clerk: string;
  let sessionId: string, classId: string;
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
  async function hire(i: number, designationId = tgt) {
    const r = await m.registerEmployee(hr, {
      firstName: "Synthetic",
      middleName: null,
      lastName: `Life ${run} ${i}`,
      dob: "1980-03-03",
      gender: "FEMALE",
      personalPhone: `93456${String(10000 + i).slice(1)}`,
      workPhone: null,
      personalEmail: null,
      workEmail: null,
      address: null,
      emergencyContact: null,
      departmentId: dept1,
      designationId,
      appointmentType: "PROBATION",
      joiningDate: "2025-04-01",
      confirmationDate: null,
      reportsToId: null,
    });
    employeeIds.push(r.id);
    return r.id;
  }
  const version = async (id: string) => (await m.prisma.employee.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  const events = (id: string) => m.prisma.employeeServiceEvent.findMany({ where: { employeeId: id }, orderBy: { createdAt: "asc" }, select: { eventType: true, before: true, after: true, remarks: true } });

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [r, h, lib] = await Promise.all([user("root", "SUPER_ADMIN"), user("hr", "HR_MANAGER"), user("lib", "LIBRARIAN")]);
    // KI-069: lifecycle changes need the actor's own login linked to a staff record (before the session is created).
    await (await import("./staff-fixture")).linkTeachingEmployee(m.prisma, tag, h.id, { staffType: "NON_TEACHING" });
    [root, hr, librarian] = await Promise.all([r, h, lib].map((u) => ctxFor(u.id)));
    dept1 = (await m.createDepartment(hr, { code: `${tag}-D1`, name: `${run} Dept 1` }))!.id;
    dept2 = (await m.createDepartment(hr, { code: `${tag}-D2`, name: `${run} Dept 2` }))!.id;
    tgt = (await m.createDesignation(hr, { code: `${tag}-TGT`, name: `${run} TGT`, staffType: "TEACHING" }))!.id;
    pgt = (await m.createDesignation(hr, { code: `${tag}-PGT`, name: `${run} PGT`, staffType: "TEACHING" }))!.id;
    clerk = (await m.createDesignation(hr, { code: `${tag}-CLK`, name: `${run} Clerk`, staffType: "NON_TEACHING" }))!.id;
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    classId = (await m.createClass(root, { code: `${tag}-L`, name: `${run} Class L`, numericLevel: 3, displayOrder: 0, defaultSectionCapacity: null }))!.id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await (await import("./staff-fixture")).removeStaffFixtures(prisma, tag);
    await prisma.section.deleteMany({ where: { classId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.updateMany({ where: { employeeId: { in: employeeIds } }, data: { employeeId: null } });
    await prisma.employeeServiceEvent.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employee.updateMany({ where: { id: { in: employeeIds } }, data: { reportsToId: null } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await prisma.designation.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.department.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.$transaction(async (tx) => {
      await m.lockSuperAdminGuard(tx);
      await tx.user.deleteMany({ where: { username: { startsWith: run } } });
    });
    await prisma.$disconnect();
  }, 120_000);

  it("employment change: one event per changed item, same staff type only, confirmation can't be removed", async () => {
    const e = await hire(1);
    expect(await m.changeEmployment(hr, { id: e, version: 1, effectiveDate: "2026-01-01", departmentId: dept2, designationId: pgt, appointmentType: "PERMANENT", confirmationDate: "2025-10-01", remarks: "Synthetic promotion" })).toEqual({ events: 4 });
    expect((await events(e)).map((x) => x.eventType)).toEqual(["JOINED", "DEPARTMENT_CHANGED", "DESIGNATION_CHANGED", "APPOINTMENT_TYPE_CHANGED", "CONFIRMED"]);
    await expect(m.changeEmployment(hr, { id: e, version: 2, effectiveDate: "2026-01-01", departmentId: dept2, designationId: clerk, appointmentType: "PERMANENT", confirmationDate: "2025-10-01", remarks: null })).rejects.toMatchObject({ details: [{ path: "designationId" }] });
    await expect(m.changeEmployment(hr, { id: e, version: 2, effectiveDate: "2026-01-01", departmentId: dept2, designationId: pgt, appointmentType: "PERMANENT", confirmationDate: null, remarks: null })).rejects.toMatchObject({ details: [{ path: "confirmationDate" }] });
    expect(await m.changeEmployment(hr, { id: e, version: 2, effectiveDate: "2026-01-01", departmentId: dept2, designationId: pgt, appointmentType: "PERMANENT", confirmationDate: "2025-10-01", remarks: null })).toEqual({ events: 0 });
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "employee.change_employment", entityId: e } });
    expect(JSON.stringify({ b: log.before, a: log.after })).not.toMatch(/PERMANENT|PROBATION|2025-10-01|Synthetic promotion/);
  });

  it("reporting: loops refused; two simultaneous opposite changes can't both succeed", async () => {
    const [a, b, c] = [await hire(2), await hire(3), await hire(4)];
    await m.changeReporting(hr, { id: a, version: 1, reportsToId: b, effectiveDate: "2026-01-01", remarks: null });
    await m.changeReporting(hr, { id: b, version: 1, reportsToId: c, effectiveDate: "2026-01-01", remarks: null });
    await expect(m.changeReporting(hr, { id: c, version: 1, reportsToId: a, effectiveDate: "2026-01-01", remarks: null })).rejects.toMatchObject({ details: [{ path: "reportsToId" }] });
    const [x, y] = [await hire(5), await hire(6)];
    const results = await Promise.allSettled([
      m.changeReporting(hr, { id: x, version: 1, reportsToId: y, effectiveDate: "2026-01-01", remarks: null }),
      m.changeReporting(hr, { id: y, version: 1, reportsToId: x, effectiveDate: "2026-01-01", remarks: null }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [rx, ry] = await Promise.all([x, y].map((id) => m.prisma.employee.findUniqueOrThrow({ where: { id }, select: { reportsToId: true } })));
    expect(rx.reportsToId === y && ry.reportsToId === x).toBe(false);
  });

  it("leaving: releases class-teacher sections and deactivates the login in one transaction (Super Admin); history + audit", async () => {
    const e = await hire(7);
    const teacherUser = await user("t7", "TEACHER");
    await m.linkStaffAccount(root, { employeeId: e, userId: teacherUser.id });
    const [sec] = await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A"], capacity: null });
    await m.assignClassTeacher(root, { id: sec.id, version: 1, userId: teacherUser.id });
    const r = await m.changeStatus(root, { id: e, version: await version(e), action: "RESIGN", effectiveDate: "2026-10-31", reason: "Synthetic relocation", deactivateAccount: true });
    expect(r).toEqual({ status: "RESIGNED", sectionsReleased: 1, accountDeactivated: true, accountStillActive: false });
    expect((await m.prisma.section.findUniqueOrThrow({ where: { id: sec.id } })).classTeacherId).toBeNull();
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: teacherUser.id } })).isActive).toBe(false);
    expect(await m.prisma.session.count({ where: { userId: teacherUser.id } })).toBe(0);
    expect((await m.prisma.employee.findUniqueOrThrow({ where: { id: e } })).employmentStatus).toBe("RESIGNED");
    expect((await events(e)).at(-1)).toMatchObject({ eventType: "RESIGNED", remarks: "Synthetic relocation" });
    // A leaver can't be made a manager or class teacher.
    const other = await hire(8);
    await expect(m.changeReporting(hr, { id: other, version: 1, reportsToId: e, effectiveDate: "2026-11-01", remarks: null })).rejects.toMatchObject({ details: [{ path: "reportsToId" }] });
  });

  it("leaving by HR Manager (no user.manage): recorded, sections released, the screen is told the login is still active", async () => {
    const e = await hire(9);
    const u = await user("t9", "TEACHER");
    await m.linkStaffAccount(root, { employeeId: e, userId: u.id });
    await expect(m.changeStatus(hr, { id: e, version: await version(e), action: "RETIRE", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: true })).rejects.toBeInstanceOf(m.ForbiddenError);
    const r = await m.changeStatus(hr, { id: e, version: await version(e), action: "RETIRE", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: false });
    expect(r).toMatchObject({ status: "RETIRED", accountDeactivated: false, accountStillActive: true });
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: u.id } })).isActive).toBe(true);
  });

  it("rejoining: same code, ACTIVE again, leaving fields cleared (history keeps them); dates checked", async () => {
    const e = await hire(10);
    const code = (await m.prisma.employee.findUniqueOrThrow({ where: { id: e } })).employeeCode;
    await m.changeStatus(hr, { id: e, version: 1, action: "TERMINATE", effectiveDate: "2026-06-30", reason: "Synthetic", deactivateAccount: false });
    await expect(m.changeStatus(hr, { id: e, version: 2, action: "REJOIN", effectiveDate: "2026-06-29", reason: "Synthetic", deactivateAccount: false })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.changeStatus(hr, { id: e, version: 2, action: "RESIGN", effectiveDate: "2026-07-01", reason: "Synthetic", deactivateAccount: false })).rejects.toBeInstanceOf(m.ConflictError);
    await m.changeStatus(hr, { id: e, version: 2, action: "REJOIN", effectiveDate: "2026-08-01", reason: "Synthetic return", deactivateAccount: false });
    expect(await m.prisma.employee.findUniqueOrThrow({ where: { id: e }, select: { employeeCode: true, employmentStatus: true, leavingDate: true, leavingReason: true } })).toEqual({ employeeCode: code, employmentStatus: "ACTIVE", leavingDate: null, leavingReason: null });
    expect((await events(e)).map((x) => x.eventType)).toEqual(["JOINED", "TERMINATED", "REJOINED"]);
  });

  it("KI-069: an HR Manager whose login isn't linked to a staff record is refused; nothing written", async () => {
    const unlinked = await ctxFor((await user("hrx", "HR_MANAGER")).id);
    const e = employeeIds[0];
    await expect(m.changeStatus(unlinked, { id: e, version: await version(e), action: "START_LEAVE", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: false })).rejects.toThrow(/isn't linked/);
  });

  it("history is personal tier: Librarian gets none; HR sees events with remarks; nobody can edit or delete events via a service", async () => {
    const e = employeeIds[0];
    expect(await m.listServiceHistory(librarian, e)).toMatchObject({ restricted: true, events: [] });
    const h = await m.listServiceHistory(hr, e);
    expect(h.restricted).toBe(false);
    expect(h.events.length).toBeGreaterThan(1);
    expect(h.names.department[dept2]).toBe(`${run} Dept 2`);
    const exported = Object.keys(await import("@/modules/hr/employee-lifecycle.service"));
    expect(exported.filter((k) => /update|delete|remove/i.test(k) && /event|history/i.test(k))).toEqual([]);
  });

  it("review L1: deactivation refusals roll back the whole leaving (own account; more privileged account); readers get 403", async () => {
    const rootUserId = root.userId;
    // (a) Super Admin linked to their own employee record can't deactivate their own login while leaving.
    const own = await hire(11);
    await m.linkStaffAccount(root, { employeeId: own, userId: rootUserId });
    await expect(m.changeStatus(root, { id: own, version: await version(own), action: "RESIGN", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: true })).rejects.toThrow(/your own account/);
    expect((await m.prisma.employee.findUniqueOrThrow({ where: { id: own } })).employmentStatus).toBe("ACTIVE"); // rolled back
    await m.unlinkStaffAccount(root, own);

    // (b) A delegated admin (custom role) can't deactivate a more privileged (Principal) account — nothing is written.
    const keys = ["user.read", "user.manage", "employee.read", "employee.personal.read", "employee.manage"];
    const perms = await m.prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
    const roleKey = `HL_DELEGATE_${Date.now().toString(36).toUpperCase()}`;
    const role = await m.prisma.role.create({ data: { key: roleKey, name: `${run} delegate`, permissions: { create: perms.map((p) => ({ permissionId: p.id, scope: "ALL" as const })) } } });
    try {
      const delegateUser = await m.prisma.user.create({ data: { username: `${run}-delegate`, displayName: "Synthetic delegate", passwordHash: "x", roles: { create: { roleId: role.id } } } });
      const delegate = await ctxFor(delegateUser.id);
      const principalEmp = await hire(12);
      const principalUser = await user("pr12", "PRINCIPAL");
      await m.linkStaffAccount(root, { employeeId: principalEmp, userId: principalUser.id });
      await expect(m.changeStatus(delegate, { id: principalEmp, version: await version(principalEmp), action: "RETIRE", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: true })).rejects.toBeInstanceOf(m.ForbiddenError);
      expect((await m.prisma.employee.findUniqueOrThrow({ where: { id: principalEmp } })).employmentStatus).toBe("ACTIVE");
      expect((await m.prisma.user.findUniqueOrThrow({ where: { id: principalUser.id } })).isActive).toBe(true);
      await m.unlinkStaffAccount(root, principalEmp);
      await m.prisma.user.delete({ where: { id: delegateUser.id } });
    } finally {
      await m.prisma.role.delete({ where: { id: role.id } });
    }

    // (c) Readers can't use any lifecycle write.
    const target = employeeIds[0];
    await expect(m.changeStatus(librarian, { id: target, version: await version(target), action: "START_LEAVE", effectiveDate: "2026-10-31", reason: "Synthetic", deactivateAccount: false })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.changeReporting(librarian, { id: target, version: await version(target), reportsToId: null, effectiveDate: "2026-10-31", remarks: null })).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("review L4: a status change can't be dated before the last recorded status change", async () => {
    const e = await hire(13);
    await m.changeStatus(hr, { id: e, version: 1, action: "RESIGN", effectiveDate: "2026-05-31", reason: "Synthetic", deactivateAccount: false });
    await m.changeStatus(hr, { id: e, version: 2, action: "REJOIN", effectiveDate: "2026-09-01", reason: "Synthetic", deactivateAccount: false });
    await expect(m.changeStatus(hr, { id: e, version: 3, action: "RESIGN", effectiveDate: "2026-08-01", reason: "Synthetic", deactivateAccount: false })).rejects.toMatchObject({ details: [{ path: "effectiveDate" }] });
  });
});
