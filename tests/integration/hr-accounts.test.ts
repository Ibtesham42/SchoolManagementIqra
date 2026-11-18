import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 3A M3a — teacher profiles (H14) and login-account links (H2) against real Postgres (Test branch only,
 * behind the S-05 guard; skipped without TEST_DATABASE_URL). Synthetic data only; removed in afterAll except
 * audit rows and the shared employee-code counter rows. Needs the M2 catalog on Test (KI-062).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/identity/super-admin-guard")),
  ...(await import("@/modules/hr/master-data.service")),
  ...(await import("@/modules/hr/employees.service")),
  ...(await import("@/modules/hr/teacher-profiles.service")),
  ...(await import("@/modules/hr/staff-accounts.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR teacher profiles and account links (integration)", () => {
  const run = `ha${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, hr: Ctx, schoolAdmin: Ctx, librarian: Ctx;
  let teacherEmpId: string, clerkEmpId: string, secondTeacherId: string;
  let staffUserId: string, otherUserId: string, inactiveUserId: string, rootUserId: string;
  let linker: Ctx, principalUserId: string, deletedUserId: string, linkerUserId: string;
  const customRoleKey = `HA_LINKER_${Date.now().toString(36).toUpperCase()}`;
  const employeeIds: string[] = [];

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string, extra: { isActive?: boolean } = {}) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    // Rule 17 / ADR-025: changes to Super Admin membership take the guard first (also in fixtures).
    return m.prisma.$transaction(async (tx) => {
      if (roleKey === "SUPER_ADMIN") await m.lockSuperAdminGuard(tx);
      return tx.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", ...extra, roles: { create: { roleId: role.id } } } });
    });
  }
  const employee = (designationId: string, departmentId: string, i: number) => ({
    firstName: "Synthetic",
    middleName: null,
    lastName: `Teacher ${run} ${i}`,
    dob: "1988-02-02",
    gender: "MALE" as const,
    personalPhone: `91234${String(10000 + i).slice(1)}`,
    workPhone: null,
    personalEmail: null,
    workEmail: null,
    address: null,
    emergencyContact: null,
    departmentId,
    designationId,
    appointmentType: "PERMANENT" as const,
    joiningDate: "2026-04-01",
    confirmationDate: null,
    reportsToId: null,
  });
  const profile = (employeeId: string, version: number | null, over: Record<string, unknown> = {}) => ({
    employeeId,
    version,
    qualifications: [{ degree: "M.Sc.", subject: "Physics", institution: null, year: 2010 }],
    professionalQualifications: [{ name: "B.Ed", year: 2011 }],
    specializations: ["Physics"],
    experienceYearsBefore: 4,
    teacherRegistrationNo: null,
    ...over,
  });

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [r, h, sa, lib, staff, other, off] = await Promise.all([
      user("root", "SUPER_ADMIN"),
      user("hr", "HR_MANAGER"),
      user("sa", "SCHOOL_ADMIN"),
      user("lib", "LIBRARIAN"),
      user("staff", "TEACHER"),
      user("other", "TEACHER"),
      user("off", "TEACHER", { isActive: false }),
    ]);
    rootUserId = r.id;
    [root, hr, schoolAdmin, librarian] = await Promise.all([r, h, sa, lib].map((u) => ctxFor(u.id)));
    [staffUserId, otherUserId, inactiveUserId] = [staff.id, other.id, off.id];
    const dept = (await m.createDepartment(hr, { code: `${tag}-D`, name: `${run} Dept` }))!.id;
    const tgt = (await m.createDesignation(hr, { code: `${tag}-T`, name: `${run} TGT`, staffType: "TEACHING" }))!.id;
    const clk = (await m.createDesignation(hr, { code: `${tag}-C`, name: `${run} Clerk`, staffType: "NON_TEACHING" }))!.id;
    for (const [i, desig] of [tgt, clk, tgt, tgt].entries()) employeeIds.push((await m.registerEmployee(hr, employee(desig, dept, i))).id);
    [teacherEmpId, clerkEmpId, secondTeacherId] = employeeIds;
    // Review M3a L3: a custom (non–Super Admin) role holding both link permissions.
    const perms = await m.prisma.permission.findMany({ where: { key: { in: ["employee.read", "employee.personal.read", "employee.manage", "user.read", "user.manage"] } }, select: { id: true } });
    const role = await m.prisma.role.create({ data: { key: customRoleKey, name: `${run} linker`, permissions: { create: perms.map((p) => ({ permissionId: p.id, scope: "ALL" as const })) } } });
    const lk = await m.prisma.user.create({ data: { username: `${run}-linker`, displayName: "Synthetic linker", passwordHash: "x", roles: { create: { roleId: role.id } } } });
    linkerUserId = lk.id;
    linker = await ctxFor(lk.id);
    principalUserId = (await user("pr", "PRINCIPAL")).id;
    deletedUserId = (await user("gone", "TEACHER")).id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.user.updateMany({ where: { employeeId: { in: employeeIds } }, data: { employeeId: null } });
    await prisma.teacherProfile.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employeeServiceEvent.deleteMany({ where: { employeeId: { in: employeeIds } } });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await prisma.designation.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.department.deleteMany({ where: { code: { startsWith: `${tag}-` } } });
    await prisma.$transaction(async (tx) => {
      await m.lockSuperAdminGuard(tx);
      await tx.user.deleteMany({ where: { username: { startsWith: run } } });
    });
    await prisma.role.deleteMany({ where: { key: customRoleKey } });
    await prisma.$disconnect();
  }, 120_000);

  it("teacher profile: create, versioned update, field-name-only audit; refused for non-teaching staff and for readers", async () => {
    await m.saveTeacherProfile(hr, profile(teacherEmpId, null));
    expect(await m.getTeacherProfile(librarian, teacherEmpId)).toMatchObject({ version: 1, specializations: ["Physics"] });
    await expect(m.saveTeacherProfile(hr, profile(teacherEmpId, null))).rejects.toBeInstanceOf(m.ConflictError); // already exists
    await m.saveTeacherProfile(schoolAdmin, profile(teacherEmpId, 1, { specializations: ["Physics", "Chemistry"] }));
    await expect(m.saveTeacherProfile(hr, profile(teacherEmpId, 1))).rejects.toBeInstanceOf(m.ConflictError); // stale
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "teacher_profile.update", entityId: teacherEmpId } });
    expect(log.after).toEqual({ fields: ["specializations"], version: 2 });
    await expect(m.saveTeacherProfile(hr, profile(clerkEmpId, null))).rejects.toThrow(/teaching staff/);
    await expect(m.saveTeacherProfile(librarian, profile(secondTeacherId, null))).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("the database caps specializations at 10 even for a direct write", async () => {
    await expect(m.prisma.teacherProfile.create({ data: { employeeId: secondTeacherId, specializations: Array.from({ length: 11 }, (_, i) => `S${i}`) } })).rejects.toThrow();
  });

  it("account link: Super Admin links one active account per employee; refusals for linked, inactive, other links and missing permissions", async () => {
    expect(await m.linkStaffAccount(root, { employeeId: teacherEmpId, userId: staffUserId })).toEqual({ username: `${run}-staff` });
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: staffUserId } })).employeeId).toBe(teacherEmpId);
    await expect(m.linkStaffAccount(root, { employeeId: teacherEmpId, userId: otherUserId })).rejects.toThrow(/already has a login account/);
    await expect(m.linkStaffAccount(root, { employeeId: secondTeacherId, userId: staffUserId })).rejects.toThrow(/already linked to another employee/);
    await expect(m.linkStaffAccount(root, { employeeId: secondTeacherId, userId: inactiveUserId })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.linkStaffAccount(hr, { employeeId: secondTeacherId, userId: otherUserId })).rejects.toBeInstanceOf(m.ForbiddenError); // Q2
    await expect(m.linkStaffAccount(schoolAdmin, { employeeId: secondTeacherId, userId: otherUserId })).rejects.toBeInstanceOf(m.ForbiddenError);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "user.employee_link", entityId: staffUserId } });
    expect(log.after).toEqual({ employeeId: teacherEmpId });
  });

  it("concurrent links of two accounts to one employee: exactly one wins", async () => {
    const results = await Promise.allSettled([
      m.linkStaffAccount(root, { employeeId: secondTeacherId, userId: otherUserId }),
      m.linkStaffAccount(root, { employeeId: secondTeacherId, userId: rootUserId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await m.prisma.user.count({ where: { employeeId: secondTeacherId } })).toBe(1);
    await m.unlinkStaffAccount(root, secondTeacherId);
  });

  it("review L3: a non–Super Admin linker can't link a Super Admin or a more privileged account, but can link a covered one", async () => {
    const fourth = employeeIds[3];
    await expect(m.linkStaffAccount(linker, { employeeId: fourth, userId: rootUserId })).rejects.toThrow(/Super Admin/);
    await expect(m.linkStaffAccount(linker, { employeeId: fourth, userId: principalUserId })).rejects.toThrow(/permissions you also hold/);
    expect(await m.prisma.user.count({ where: { employeeId: fourth } })).toBe(0);
    // A Teacher's permissions are not all held by the linker either (student.read etc.) — refused too.
    await expect(m.linkStaffAccount(linker, { employeeId: fourth, userId: otherUserId })).rejects.toBeInstanceOf(m.ForbiddenError);
    // KI-065 (M3b): a non–Super Admin can't link their OWN account (it would gain SELF access to that record).
    await expect(m.linkStaffAccount(linker, { employeeId: fourth, userId: linkerUserId })).rejects.toThrow(/your own account/);
    expect(await m.prisma.user.count({ where: { employeeId: fourth } })).toBe(0);
  });

  it("review L2: a soft-deleted linked account doesn't block unlinking", async () => {
    const fourth = employeeIds[3];
    await m.linkStaffAccount(root, { employeeId: fourth, userId: deletedUserId });
    await m.prisma.user.update({ where: { id: deletedUserId }, data: { deletedAt: new Date(), isActive: false } });
    await m.unlinkStaffAccount(root, fourth);
    expect((await m.prisma.user.findUniqueOrThrow({ where: { id: deletedUserId } })).employeeId).toBeNull();
    expect(await m.prisma.auditLog.count({ where: { action: "user.employee_unlink", entityId: deletedUserId } })).toBe(1);
  });

  it("unlink: removes the link (account untouched), audited; idempotent; panel visibility follows user.read", async () => {
    await m.unlinkStaffAccount(root, teacherEmpId);
    const u = await m.prisma.user.findUniqueOrThrow({ where: { id: staffUserId } });
    expect(u).toMatchObject({ employeeId: null, isActive: true });
    await m.unlinkStaffAccount(root, teacherEmpId); // nothing linked → no-op
    expect(await m.prisma.auditLog.count({ where: { action: "user.employee_unlink", entityId: staffUserId } })).toBe(1);
    expect(await m.staffAccountPanel(librarian, teacherEmpId)).toBeNull(); // no user.read
    expect(await m.staffAccountPanel(schoolAdmin, teacherEmpId)).toMatchObject({ linked: null, canLink: false, candidates: [] });
  });

  it("M3b \"My profile\": a linked staff account reads its OWN record with personal details; nothing else", async () => {
    const own = employeeIds[1]; // the clerk record
    await m.linkStaffAccount(root, { employeeId: own, userId: staffUserId });
    const me = await ctxFor(staffUserId); // a new session carries the link (AuthContext.employeeId)
    expect(me.employeeId).toBe(own);
    expect(await m.getEmployee(me, own)).toMatchObject({ tier: "personal", id: own });
    await expect(m.getEmployee(me, teacherEmpId)).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.listEmployees(me, { page: 1, pageSize: 25 })).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(m.getTeacherProfile(me, teacherEmpId)).rejects.toBeInstanceOf(m.NotFoundError);
    await m.unlinkStaffAccount(root, own);
    const after = await ctxFor(staffUserId);
    await expect(m.getEmployee(after, own)).rejects.toBeInstanceOf(m.NotFoundError); // link removed → SELF gives nothing
  });
});
