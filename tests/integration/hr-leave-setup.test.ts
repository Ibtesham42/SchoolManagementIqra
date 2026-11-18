import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3B M2 — leave set-up against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped
 * without TEST_DATABASE_URL): leave types (L2), holidays, staff weekly off (L3) and opening balances (L1, L5).
 * Real transactions, unique indexes, CHECKs, versions, audit rows and RBAC. Synthetic data only, in a far-future
 * academic session so nothing collides with other suites; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/hr/leave-setup.service")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled
  ? await load()
  : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR leave set-up (integration)", () => {
  const run = `lv${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = 2100 + Math.floor(Math.random() * 800);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx, teacher: Ctx, accountant: Ctx, superAdmin: Ctx;
  let sessionId: string,
    closedSessionId: string,
    teacherEmployeeId: string,
    hrEmployeeId: string;
  let weeklyOffBefore: unknown;
  const typeIds: string[] = [];

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({
      where: { key: roleKey },
    });
    return m.prisma.user.create({
      data: {
        username: `${run}-${suffix}`,
        displayName: `Synthetic ${suffix}`,
        passwordHash: "x",
        roles: { create: { roleId: role.id } },
      },
    });
  }
  const typeInput = (over: Record<string, unknown> = {}) => ({
    code: `${tag}CL`,
    name: `${run} Casual`,
    isPaid: true,
    annualQuota: "12",
    allowHalfDay: true,
    carryForwardMax: "0",
    appliesTo: "ALL" as const,
    ...over,
  });
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, t, a, sa] = await Promise.all([
      user("hr", "HR_MANAGER"),
      user("t", "TEACHER"),
      user("acc", "ACCOUNTANT"),
      user("sa", "SUPER_ADMIN"),
    ]);
    teacherEmployeeId = await linkTeachingEmployee(m.prisma, tag, t.id);
    hrEmployeeId = await linkTeachingEmployee(m.prisma, tag, h.id, {
      staffType: "NON_TEACHING",
    });
    [hr, teacher, accountant, superAdmin] = await Promise.all(
      [h, t, a, sa].map((u) => ctxFor(u.id)),
    );
    sessionId = (
      await m.prisma.academicSession.create({
        data: {
          name: `${run}-${year}`,
          startDate: d(`${year}-04-01`),
          endDate: d(`${year + 1}-03-31`),
          status: "ACTIVE",
        },
        select: { id: true },
      })
    ).id;
    closedSessionId = (
      await m.prisma.academicSession.create({
        data: {
          name: `${run}-${year - 1}`,
          startDate: d(`${year - 1}-04-01`),
          endDate: d(`${year}-03-31`),
          status: "CLOSED",
        },
        select: { id: true },
      })
    ).id;
    weeklyOffBefore =
      (await m.prisma.schoolSetting.findFirst({ select: { weeklyOff: true } }))
        ?.weeklyOff ?? null;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.leaveBalance.deleteMany({
      where: { academicSessionId: { in: [sessionId, closedSessionId] } },
    });
    await prisma.leaveType.deleteMany({ where: { id: { in: typeIds } } });
    await prisma.holiday.deleteMany({
      where: {
        date: { gte: d(`${year - 1}-04-01`), lte: d(`${year + 1}-03-31`) },
      },
    });
    await prisma.academicSession.deleteMany({
      where: { id: { in: [sessionId, closedSessionId] } },
    });
    await prisma.schoolSetting.updateMany({
      data: {
        weeklyOff:
          weeklyOffBefore === null
            ? { days: [], saturdays: [] }
            : (weeklyOffBefore as object),
      },
    });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("RBAC: only employee.manage holders write; teacher and accountant get Forbidden", async () => {
    for (const ctx of [teacher, accountant]) {
      await expect(m.createLeaveType(ctx, typeInput())).rejects.toBeInstanceOf(
        m.ForbiddenError,
      );
      await expect(
        m.createHoliday(ctx, {
          date: `${year}-08-15`,
          name: "Synthetic day",
          appliesTo: "ALL",
        }),
      ).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    await expect(
      m.updateStaffWeeklyOff(hr, { days: [0], saturdays: [] }),
    ).rejects.toBeInstanceOf(m.ForbiddenError); // settings.manage only
  });

  it("leave types: create, duplicate code/name refused, optimistic version, audit", async () => {
    const t = (await m.createLeaveType(hr, typeInput()))!;
    typeIds.push(t.id);
    expect(t).toMatchObject({
      code: `${tag}CL`,
      isPaid: true,
      version: 1,
      isActive: true,
    });
    await expect(
      m.createLeaveType(hr, typeInput({ name: `${run} Other` })),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await expect(
      m.createLeaveType(
        hr,
        typeInput({
          code: `${tag}XX`,
          name: `  ${run.toUpperCase()}   casual `,
        }),
      ),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.updateLeaveType(hr, {
      id: t.id,
      version: 1,
      ...typeInput({ annualQuota: "10" }),
    });
    await expect(
      m.updateLeaveType(hr, {
        id: t.id,
        version: 1,
        ...typeInput({ annualQuota: "8" }),
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    const row = await m.prisma.leaveType.findUniqueOrThrow({
      where: { id: t.id },
    });
    expect(row.annualQuota?.toString()).toBe("10");
    expect(row.version).toBe(2);
    expect(
      await m.prisma.auditLog.count({
        where: {
          entityId: t.id,
          action: { in: ["leave_type.create", "leave_type.update"] },
        },
      }),
    ).toBe(2);
  });

  it("database CHECK refuses unpaid carry-forward even past the schema", async () => {
    await expect(
      m.prisma.leaveType.create({
        data: {
          code: `${tag}UX`,
          name: `${run} Bad`,
          nameKey: `${run} bad`,
          isPaid: false,
          carryForwardMax: 5,
          appliesTo: "ALL",
        },
      }),
    ).rejects.toThrow();
  });

  it("opening balances: create, version, can't go below used, staff type and closed session enforced", async () => {
    const cl = typeIds[0];
    const nt = (await m.createLeaveType(
      hr,
      typeInput({
        code: `${tag}NT`,
        name: `${run} Office only`,
        appliesTo: "NON_TEACHING",
      }),
    ))!;
    typeIds.push(nt.id);
    const base = {
      employeeId: teacherEmployeeId,
      leaveTypeId: cl,
      academicSessionId: sessionId,
      allotted: "10",
      carriedForward: "1.5",
    };
    await m.setOpeningBalance(hr, { ...base, version: null });
    await expect(
      m.setOpeningBalance(hr, { ...base, version: null }),
    ).rejects.toBeInstanceOf(m.ConflictError); // already exists
    const b = await m.prisma.leaveBalance.findFirstOrThrow({
      where: {
        employeeId: teacherEmployeeId,
        leaveTypeId: cl,
        academicSessionId: sessionId,
      },
    });
    expect([
      b.allotted.toString(),
      b.carriedForward.toString(),
      b.used.toString(),
      b.version,
    ]).toEqual(["10", "1.5", "0", 1]);
    await m.prisma.leaveBalance.update({
      where: { id: b.id },
      data: { used: 4 },
    }); // simulate approved leave (M3)
    await expect(
      m.setOpeningBalance(hr, {
        ...base,
        version: 1,
        allotted: "2",
        carriedForward: "1.5",
      }),
    ).rejects.toBeInstanceOf(m.ValidationError);
    await m.setOpeningBalance(hr, {
      ...base,
      version: 1,
      allotted: "12",
      carriedForward: "0",
    });
    expect(
      (await m.prisma.leaveBalance.findUniqueOrThrow({ where: { id: b.id } }))
        .version,
    ).toBe(2);
    await expect(
      m.setOpeningBalance(hr, { ...base, leaveTypeId: nt.id, version: null }),
    ).rejects.toBeInstanceOf(m.ValidationError);
    await expect(
      m.setOpeningBalance(hr, {
        ...base,
        academicSessionId: closedSessionId,
        version: null,
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    const log = await m.prisma.auditLog.findFirstOrThrow({
      where: { entityId: b.id, action: "leave_balance.adjust" },
    });
    expect(log.after).toMatchObject({ allotted: "12", carriedForward: "0" });
    // the teacher reads their own balances (SELF personal tier); the accountant (SELF, not their record) gets NotFound
    expect(
      (await m.listLeaveBalances(teacher, teacherEmployeeId, sessionId))?.map(
        (x) => x.leaveType.id,
      ),
    ).toEqual([cl]);
    await expect(
      m.listLeaveBalances(accountant, teacherEmployeeId, sessionId),
    ).rejects.toBeInstanceOf(m.NotFoundError);
    // KI-069: HR may not set their own balance
    await expect(
      m.setOpeningBalance(hr, {
        ...base,
        employeeId: hrEmployeeId,
        version: null,
      }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("in-use leave types keep their code, paid flag and applies-to", async () => {
    const cl = await m.prisma.leaveType.findUniqueOrThrow({
      where: { id: typeIds[0] },
    });
    await expect(
      m.updateLeaveType(hr, {
        id: cl.id,
        version: cl.version,
        ...typeInput({ isPaid: false }),
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.updateLeaveType(hr, {
      id: cl.id,
      version: cl.version,
      ...typeInput({ name: `${run} Casual renamed`, annualQuota: "10" }),
    });
  });

  it("holidays: duplicate refused, listed within the session, removal blocked once leave covers the date", async () => {
    const h = (await m.createHoliday(hr, {
      date: `${year}-08-15`,
      name: "Synthetic day",
      appliesTo: "ALL",
    }))!;
    await expect(
      m.createHoliday(hr, {
        date: `${year}-08-15`,
        name: "Again",
        appliesTo: "ALL",
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.createHoliday(hr, {
      date: `${year}-08-15`,
      name: "Students extra",
      appliesTo: "STUDENTS",
    });
    expect(
      (await m.listHolidays(teacher, sessionId)).map((x) => x.appliesTo),
    ).toEqual(["ALL", "STUDENTS"]);
    const req = await m.prisma.leaveRequest.create({
      data: {
        employeeId: teacherEmployeeId,
        leaveTypeId: typeIds[0],
        academicSessionId: sessionId,
        fromDate: d(`${year}-08-14`),
        toDate: d(`${year}-08-17`),
        days: 2,
        status: "PENDING",
        reason: "Synthetic",
      },
      select: { id: true },
    });
    await expect(m.removeHoliday(hr, h.id)).rejects.toBeInstanceOf(
      m.ConflictError,
    );
    await expect(
      m.createHoliday(hr, {
        date: `${year}-08-16`,
        name: "New staff day",
        appliesTo: "STAFF",
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.leaveRequest.delete({ where: { id: req.id } });
    await m.removeHoliday(hr, h.id);
    expect(await m.prisma.holiday.count({ where: { id: h.id } })).toBe(0);
    expect(
      await m.prisma.auditLog.count({
        where: {
          entityId: h.id,
          action: { in: ["holiday.create", "holiday.remove"] },
        },
      }),
    ).toBe(2);
  });

  it("weekly off: settings.manage saves a normalised value, invalid combinations refused, audited", async () => {
    await m.updateStaffWeeklyOff(superAdmin, { days: [0], saturdays: [4, 2] });
    expect(await m.getStaffWeeklyOff(superAdmin)).toEqual({
      days: [0],
      saturdays: [2, 4],
    });
    await expect(
      m.updateStaffWeeklyOff(superAdmin, { days: [6], saturdays: [2] }),
    ).rejects.toThrow();
    expect(
      await m.prisma.auditLog.count({
        where: {
          action: "settings.weekly_off_update",
          createdAt: { gte: new Date(Date.now() - 60_000) },
        },
      }),
    ).toBeGreaterThan(0);
  });
  it("RBAC (table-driven over every seeded role, unlinked users): writes refused without employee.manage; reads need a leave/HR permission", async () => {
    const { ROLES } = await import("@/lib/rbac/catalog");
    const { hasPermission } = await import("@/lib/rbac/authorize");
    const t = await m.prisma.leaveType.findUniqueOrThrow({
      where: { id: typeIds[0] },
    });
    const h = (await m.createHoliday(hr, {
      date: `${year}-09-05`,
      name: "Synthetic RBAC day",
      appliesTo: "STUDENTS",
    }))!;
    for (const role of ROLES) {
      const ctx = await ctxFor(
        (await user(`r-${role.key.toLowerCase()}`, role.key)).id,
      );
      const manage = hasPermission(ctx, "employee.manage");
      const calls: [string, () => Promise<unknown>][] = [
        [
          "createLeaveType",
          () =>
            m.createLeaveType(
              ctx,
              typeInput(), // duplicate code: managers get a ConflictError, everyone else Forbidden
            ),
        ],
        [
          "updateLeaveType",
          () =>
            m.updateLeaveType(ctx, { id: t.id, version: -1, ...typeInput() }),
        ],
        [
          "setLeaveTypeActive",
          () =>
            m.setLeaveTypeActive(ctx, { id: t.id, version: -1, active: false }),
        ],
        ["removeHoliday", () => m.removeHoliday(ctx, "missing-holiday-id")],
        [
          "setOpeningBalance",
          () =>
            m.setOpeningBalance(ctx, {
              employeeId: teacherEmployeeId,
              leaveTypeId: t.id,
              academicSessionId: sessionId,
              version: null,
              allotted: "1",
              carriedForward: "0",
            }),
        ],
      ];
      for (const [name, call] of calls) {
        if (ctx.isSuperAdmin) continue; // Super Admin holds everything; covered by the positive tests
        // managers fail later (stale version / not found / KI-069 unlinked), never with a silent write
        await expect(call(), `${role.key} ${name}`).rejects.toBeInstanceOf(
          manage ? m.AppError : m.ForbiddenError,
        );
      }
      if (!ctx.isSuperAdmin && manage) {
        await expect(
          m.setOpeningBalance(ctx, {
            employeeId: teacherEmployeeId,
            leaveTypeId: t.id,
            academicSessionId: sessionId,
            version: null,
            allotted: "1",
            carriedForward: "0",
          }),
          `${role.key} unlinked`,
        ).rejects.toBeInstanceOf(m.ForbiddenError);
      }
      const reads = ["employee.read", "leave.request", "leave.approve"].some(
        (k) => hasPermission(ctx, k as Parameters<typeof hasPermission>[1]),
      );
      if (reads) {
        const types = await m.listLeaveTypes(ctx, { includeInactive: true });
        for (const x of types)
          expect(x.inUse === null, `${role.key} sees usage`).toBe(!manage);
      } else {
        await expect(m.listLeaveTypes(ctx), role.key).rejects.toBeInstanceOf(
          m.ForbiddenError,
        );
        await expect(
          m.listHolidays(ctx, sessionId),
          role.key,
        ).rejects.toBeInstanceOf(m.ForbiddenError);
      }
    }
    expect(
      await m.prisma.leaveType.count({
        where: { code: { startsWith: `${tag}Q` } },
      }),
    ).toBe(0);
    await m.removeHoliday(hr, h.id);
  }, 300_000);

  it("concurrency (audit F1): a first balance and an applies-to change on the same unused type can't both succeed", async () => {
    const fresh = (await m.createLeaveType(
      hr,
      typeInput({
        code: `${tag}RC`,
        name: `${run} Race`,
        appliesTo: "TEACHING",
      }),
    ))!;
    typeIds.push(fresh.id);
    const [bal, upd] = await Promise.allSettled([
      m.setOpeningBalance(hr, {
        employeeId: teacherEmployeeId,
        leaveTypeId: fresh.id,
        academicSessionId: sessionId,
        version: null,
        allotted: "3",
        carriedForward: "0",
      }),
      m.updateLeaveType(hr, {
        id: fresh.id,
        version: 1,
        ...typeInput({
          code: `${tag}RC`,
          name: `${run} Race`,
          appliesTo: "NON_TEACHING",
        }),
      }),
    ]);
    const row = await m.prisma.leaveType.findUniqueOrThrow({
      where: { id: fresh.id },
      select: { appliesTo: true },
    });
    const balances = await m.prisma.leaveBalance.count({
      where: { leaveTypeId: fresh.id },
    });
    // invariant: a balance exists only on a type that applies to the (teaching) employee
    if (balances > 0) expect(row.appliesTo).toBe("TEACHING");
    expect(
      bal.status === "fulfilled" &&
        upd.status === "fulfilled" &&
        row.appliesTo === "NON_TEACHING",
    ).toBe(false);
  }, 120_000);
});
