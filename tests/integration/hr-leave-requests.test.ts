import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { linkTeachingEmployee, removeStaffFixtures } from "./staff-fixture";

/**
 * Phase 3B M3 — leave requests, decisions and cancellation against real Postgres (Neon Test branch only, behind the
 * S-05 target guard; skipped without TEST_DATABASE_URL). Real locks, CHECKs, versions and audit rows, including the
 * plan's concurrency gate: double approval, overlapping requests and holiday-vs-apply (KI-071). Synthetic data only,
 * in a far-future academic session; removed in afterAll except audit rows (append-only, S-07).
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/hr/leave-requests.service")),
  ...(await import("@/modules/hr/leave-setup.service")),
});
const m = enabled
  ? await load()
  : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR leave requests (integration)", () => {
  const run = `lr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 800);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let hr: Ctx,
    principal: Ctx,
    teacher: Ctx,
    teacher2: Ctx,
    unlinkedVp: Ctx,
    unlinkedAcc: Ctx,
    superAdmin: Ctx;
  let empT: string,
    empT2: string,
    empSa: string,
    sessionId: string,
    paidId: string,
    halfId: string,
    unpaidId: string;
  let weeklyOffBefore: unknown;
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  /** The n-th Monday (1-based) of month `mm` in year Y, as ISO; plus `plus` days. */
  const monday = (mm: number, n = 1, plus = 0) => {
    const x = d(`${Y}-${String(mm).padStart(2, "0")}-01`);
    while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() + 1);
    x.setUTCDate(x.getUTCDate() + 7 * (n - 1) + plus);
    return iso(x);
  };
  const req = (over: Record<string, unknown> = {}) =>
    ({
      leaveTypeId: paidId,
      fromDate: monday(6),
      toDate: monday(6, 1, 4),
      halfDay: null,
      reason: "Synthetic reason SECRET-R",
      ...over,
    }) as Parameters<typeof m.applyForLeave>[1];
  const ver = async (id: string) =>
    (
      await m.prisma.leaveRequest.findUniqueOrThrow({
        where: { id },
        select: { version: true },
      })
    ).version;
  const used = async (employeeId: string, leaveTypeId = paidId) =>
    (
      await m.prisma.leaveBalance.findFirstOrThrow({
        where: { employeeId, leaveTypeId, academicSessionId: sessionId },
        select: { used: true },
      })
    ).used.toString();

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
  async function type(code: string, over: Record<string, unknown> = {}) {
    const t = await m.prisma.leaveType.create({
      data: {
        code: `${tag}${code}`,
        name: `${run} ${code}`,
        nameKey: `${run} ${code}`.toLowerCase(),
        isPaid: true,
        annualQuota: 10,
        allowHalfDay: false,
        carryForwardMax: 0,
        appliesTo: "ALL",
        ...over,
      },
      select: { id: true },
    });
    return t.id;
  }
  async function balance(
    employeeId: string,
    leaveTypeId: string,
    allotted: number,
  ) {
    await m.prisma.leaveBalance.create({
      data: { employeeId, leaveTypeId, academicSessionId: sessionId, allotted },
    });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    const [h, p, t, t2, vp, acc, sa] = await Promise.all([
      user("hr", "HR_MANAGER"),
      user("pr", "PRINCIPAL"),
      user("t", "TEACHER"),
      user("t2", "TEACHER"),
      user("vp", "VICE_PRINCIPAL"),
      user("acc", "ACCOUNTANT"),
      user("sa", "SUPER_ADMIN"),
    ]);
    await linkTeachingEmployee(m.prisma, tag, h.id, {
      staffType: "NON_TEACHING",
    });
    const empP = await linkTeachingEmployee(m.prisma, tag, p.id);
    empT = await linkTeachingEmployee(m.prisma, tag, t.id);
    empT2 = await linkTeachingEmployee(m.prisma, tag, t2.id);
    empSa = await linkTeachingEmployee(m.prisma, tag, sa.id, {
      staffType: "NON_TEACHING",
    });
    await m.prisma.employee.update({
      where: { id: empT },
      data: { reportsToId: empP },
    });
    [hr, principal, teacher, teacher2, unlinkedVp, unlinkedAcc, superAdmin] =
      await Promise.all([h, p, t, t2, vp, acc, sa].map((u) => ctxFor(u.id)));
    sessionId = (
      await m.prisma.academicSession.create({
        data: {
          name: `${run}-${Y}`,
          startDate: d(`${Y}-04-01`),
          endDate: d(`${Y + 1}-03-31`),
          status: "ACTIVE",
        },
        select: { id: true },
      })
    ).id;
    paidId = await type("CL");
    halfId = await type("HD", { allowHalfDay: true });
    unpaidId = await type("LP", { isPaid: false, annualQuota: null });
    for (const e of [empT, empT2, empSa]) await balance(e, paidId, 6);
    await balance(empT, halfId, 2);
    const s = await m.prisma.schoolSetting.findFirst({
      select: { weeklyOff: true },
    });
    weeklyOffBefore = s?.weeklyOff ?? null;
    await m.prisma.schoolSetting.updateMany({
      data: { weeklyOff: { days: [0], saturdays: [] } },
    });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const types = [paidId, halfId, unpaidId].filter(Boolean);
    await prisma.employeeAttendance.deleteMany({
      where: { date: { gte: d(`${Y}-04-01`), lte: d(`${Y + 1}-03-31`) } },
    });
    await prisma.leaveRequest.deleteMany({
      where: { leaveTypeId: { in: types } },
    });
    await prisma.leaveBalance.deleteMany({
      where: { academicSessionId: sessionId },
    });
    await prisma.leaveType.deleteMany({ where: { id: { in: types } } });
    await prisma.holiday.deleteMany({
      where: { date: { gte: d(`${Y}-04-01`), lte: d(`${Y + 1}-03-31`) } },
    });
    await prisma.attendancePeriodLock.deleteMany({
      where: { month: { gte: d(`${Y}-04-01`), lte: d(`${Y + 1}-03-31`) } },
    });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.schoolSetting.updateMany({
      data: {
        weeklyOff:
          weeklyOffBefore === null
            ? { days: [], saturdays: [] }
            : (weeklyOffBefore as object),
      },
    });
    await prisma.employee.updateMany({
      where: { id: empT },
      data: { reportsToId: null },
    });
    await removeStaffFixtures(prisma, tag);
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("apply: working days only (Sunday off, staff holiday excluded, students-only holiday counted); audit has no reason", async () => {
    await m.createHoliday(hr, {
      date: monday(5, 2, 2),
      name: "Synthetic staff day",
      appliesTo: "STAFF",
    });
    await m.createHoliday(hr, {
      date: monday(5, 2, 3),
      name: "Synthetic pupils day",
      appliesTo: "STUDENTS",
    });
    const r = await m.applyForLeave(
      teacher,
      req({ fromDate: monday(5, 2), toDate: monday(5, 2, 6) }),
    ); // Mon..Sun
    expect(r.days).toBe("5"); // 7 − Sunday − staff holiday
    const log = await m.prisma.auditLog.findFirstOrThrow({
      where: { action: "leave_request.create", entityId: r.id },
    });
    expect(JSON.stringify({ a: log.after })).not.toContain("SECRET-R");
    await m.cancelLeave(teacher, { id: r.id, version: await ver(r.id) }); // withdraw (own, pending)
    expect(
      (await m.prisma.leaveRequest.findUniqueOrThrow({ where: { id: r.id } }))
        .status,
    ).toBe("CANCELLED");
  });

  it("apply refusals: unlinked, overlap, L5 balance incl. pending, half day rules, no working days", async () => {
    await expect(m.applyForLeave(unlinkedAcc, req())).rejects.toBeInstanceOf(
      m.ForbiddenError,
    );
    const a = await m.applyForLeave(
      teacher2,
      req({ fromDate: monday(7), toDate: monday(7, 1, 4) }),
    ); // 5 of 6
    await expect(
      m.applyForLeave(
        teacher2,
        req({ fromDate: monday(7, 1, 4), toDate: monday(7, 2) }),
      ),
    ).rejects.toBeInstanceOf(m.ConflictError); // overlap
    await expect(
      m.applyForLeave(
        teacher2,
        req({ fromDate: monday(7, 3), toDate: monday(7, 3, 1) }),
      ),
    ).rejects.toBeInstanceOf(m.ValidationError); // 2 > 6 − 5 pending
    await expect(
      m.applyForLeave(
        teacher2,
        req({ fromDate: monday(7, 3), toDate: monday(7, 3), halfDay: "FIRST" }),
      ),
    ).rejects.toBeInstanceOf(m.ValidationError); // type has no half days
    const h = await m.applyForLeave(
      teacher,
      req({
        leaveTypeId: halfId,
        fromDate: monday(8),
        toDate: monday(8),
        halfDay: "SECOND",
      }),
    );
    expect(h.days).toBe("0.5");
    await expect(
      m.applyForLeave(
        teacher,
        req({ fromDate: monday(8, 1, 6), toDate: monday(8, 1, 6) }),
      ),
    ).rejects.toBeInstanceOf(m.ValidationError); // a Sunday
    const u = await m.applyForLeave(
      teacher2,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(9),
        toDate: monday(9, 2, 4),
      }),
    ); // unpaid: no balance needed
    expect(u.days).toBe("10");
    for (const id of [a.id, h.id, u.id])
      await m.cancelLeave(id === h.id ? teacher : teacher2, {
        id,
        version: await ver(id),
      });
  });

  it("decide: permission, approver ≠ subject (Super Admin included), unlinked approver refused, reject note kept out of audit", async () => {
    const r = await m.applyForLeave(
      teacher,
      req({ fromDate: monday(10), toDate: monday(10, 1, 1) }),
    );
    const v = await ver(r.id);
    await expect(
      m.decideLeave(teacher2, {
        id: r.id,
        version: v,
        decision: "APPROVE",
        note: "",
      }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(
      m.decideLeave(unlinkedVp, {
        id: r.id,
        version: v,
        decision: "APPROVE",
        note: "",
      }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    const own = await m.applyForLeave(
      superAdmin,
      req({ fromDate: monday(10), toDate: monday(10) }),
    );
    await expect(
      m.decideLeave(superAdmin, {
        id: own.id,
        version: await ver(own.id),
        decision: "APPROVE",
        note: "",
      }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.decideLeave(principal, {
      id: r.id,
      version: v,
      decision: "REJECT",
      note: "Synthetic note SECRET-N",
    });
    const row = await m.prisma.leaveRequest.findUniqueOrThrow({
      where: { id: r.id },
    });
    expect([row.status, row.decisionNote, row.decidedById]).toEqual([
      "REJECTED",
      "Synthetic note SECRET-N",
      principal.userId,
    ]);
    const log = await m.prisma.auditLog.findFirstOrThrow({
      where: { action: "leave_request.reject", entityId: r.id },
    });
    expect(JSON.stringify({ b: log.before, a: log.after })).not.toContain(
      "SECRET",
    );
    await expect(
      m.decideLeave(hr, {
        id: r.id,
        version: row.version,
        decision: "APPROVE",
        note: "",
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.decideLeave(hr, {
      id: own.id,
      version: await ver(own.id),
      decision: "REJECT",
      note: "Synthetic cleanup",
    });
  });

  it("approve: balance deducted, working days marked ON_LEAVE, an ABSENT day converted, a PRESENT day blocks", async () => {
    const blockedDay = monday(11, 1, 1);
    await m.prisma.employeeAttendance.create({
      data: { employeeId: empT, date: d(blockedDay), status: "PRESENT" },
    });
    const b = await m.applyForLeave(
      teacher,
      req({ fromDate: monday(11), toDate: monday(11, 1, 2) }),
    );
    await expect(
      m.decideLeave(hr, {
        id: b.id,
        version: await ver(b.id),
        decision: "APPROVE",
        note: "",
      }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.employeeAttendance.update({
      where: { employeeId_date: { employeeId: empT, date: d(blockedDay) } },
      data: { status: "ABSENT" },
    });
    const before = await used(empT);
    await m.decideLeave(hr, {
      id: b.id,
      version: await ver(b.id),
      decision: "APPROVE",
      note: "",
    });
    expect(Number(await used(empT)) - Number(before)).toBe(3);
    const att = await m.prisma.employeeAttendance.findMany({
      where: { leaveRequestId: b.id },
      orderBy: { date: "asc" },
      select: { date: true, status: true },
    });
    expect(att.map((a) => [iso(a.date), a.status])).toEqual(
      [0, 1, 2].map((i) => [monday(11, 1, i), "ON_LEAVE"]),
    );
    // cancel by an approver before the first day: balance restored, attendance rows removed; the subject can't
    await expect(
      m.cancelLeave(teacher, { id: b.id, version: await ver(b.id) }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.cancelLeave(principal, { id: b.id, version: await ver(b.id) });
    expect(await used(empT)).toBe(before);
    expect(
      await m.prisma.employeeAttendance.count({
        where: { leaveRequestId: b.id },
      }),
    ).toBe(0);
  });

  it("withdraw/cancel rules: an approver can't withdraw someone's pending request; strangers get NotFound; started leave and locked months refused", async () => {
    const r = await m.applyForLeave(
      teacher,
      req({ fromDate: monday(12), toDate: monday(12) }),
    );
    await expect(
      m.cancelLeave(hr, { id: r.id, version: await ver(r.id) }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(
      m.cancelLeave(teacher2, { id: r.id, version: await ver(r.id) }),
    ).rejects.toBeInstanceOf(m.NotFoundError);
    await m.cancelLeave(teacher, { id: r.id, version: await ver(r.id) });
    const started = await m.prisma.leaveRequest.create({
      data: {
        employeeId: empT2,
        leaveTypeId: unpaidId,
        academicSessionId: sessionId,
        fromDate: d("2020-01-06"),
        toDate: d("2020-01-06"),
        days: 1,
        reason: "Synthetic",
        status: "APPROVED",
        decidedAt: new Date(),
        decidedById: hr.userId,
      },
      select: { id: true },
    });
    await expect(
      m.cancelLeave(principal, { id: started.id, version: 1 }),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await m.prisma.attendancePeriodLock.create({
      data: { month: d(`${Y}-12-01`) },
    });
    const dec = monday(12, 2);
    await expect(
      m.applyForLeave(teacher, req({ fromDate: dec, toDate: dec })),
    ).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("concurrency: two approvers approving the same request — exactly one succeeds, the balance moves once", async () => {
    const r = await m.applyForLeave(
      teacher2,
      req({ fromDate: monday(6, 2), toDate: monday(6, 2, 1) }),
    );
    const v = await ver(r.id);
    const before = await used(empT2);
    const out = await Promise.allSettled(
      [hr, principal].map((ctx) =>
        m.decideLeave(ctx, {
          id: r.id,
          version: v,
          decision: "APPROVE",
          note: "",
        }),
      ),
    );
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(Number(await used(empT2)) - Number(before)).toBe(2);
    expect(
      await m.prisma.employeeAttendance.count({
        where: { leaveRequestId: r.id },
      }),
    ).toBe(2);
  }, 120_000);

  it("concurrency: overlapping applications in parallel — exactly one is stored", async () => {
    const out = await Promise.allSettled(
      [0, 1, 2].map((i) =>
        m.applyForLeave(
          teacher,
          req({
            leaveTypeId: unpaidId,
            fromDate: monday(9, 3, i),
            toDate: monday(9, 3, i + 1),
          }),
        ),
      ),
    );
    expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(1);
  }, 120_000);

  it("concurrency (KI-071): a staff holiday and a leave request on the same date never both count the day", async () => {
    const hDay = monday(10, 3, 2);
    const [hol, app] = await Promise.allSettled([
      m.createHoliday(hr, {
        date: hDay,
        name: "Synthetic race day",
        appliesTo: "STAFF",
      }),
      m.applyForLeave(
        teacher2,
        req({
          leaveTypeId: unpaidId,
          fromDate: monday(10, 3),
          toDate: monday(10, 3, 4),
        }),
      ),
    ]);
    expect(app.status).toBe("fulfilled");
    const days = app.status === "fulfilled" ? app.value.days : null;
    // holiday first → 4 days; request first → holiday refused (leave covers the date) and 5 days
    if (hol.status === "fulfilled") expect(days).toBe("4");
    else
      expect([days, hol.reason instanceof m.ConflictError]).toEqual([
        "5",
        true,
      ]);
  }, 120_000);

  it("queue: approvers see other staff (reports-to first), never their own; non-approvers are refused", async () => {
    const r = await m.applyForLeave(
      teacher,
      req({ fromDate: monday(4, 3), toDate: monday(4, 3) }),
    );
    const q = await m.listLeaveQueue(principal, { status: "PENDING", page: 1 });
    const mine = q.items.find((x) => x.id === r.id);
    expect(mine).toMatchObject({
      reportsToMe: true,
      available: expect.any(String),
    });
    // reports-to rows come first on the page
    const firstOther = q.items.findIndex((x) => !x.reportsToMe);
    expect(
      firstOther === -1 || q.items.findIndex((x) => x.id === r.id) < firstOther,
    ).toBe(true);
    const asSubject = await m.applyForLeave(
      hr,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(4, 4),
        toDate: monday(4, 4),
      }),
    );
    expect(
      (await m.listLeaveQueue(hr, { status: "PENDING", page: 1 })).items.some(
        (x) => x.id === asSubject.id,
      ),
    ).toBe(false);
    await expect(
      m.listLeaveQueue(teacher, { status: "PENDING", page: 1 }),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    const mineView = await m.getMyLeave(teacher, sessionId);
    expect(
      mineView.linked &&
        mineView.requests.some(
          (x) => x.id === r.id && x.reason.includes("SECRET-R"),
        ),
    ).toBe(true);
  });
  it("RBAC (table-driven over every seeded role, unlinked users): apply needs a linked record, decide needs leave.approve + a linked login, the queue needs leave.approve", async () => {
    const { ROLES } = await import("@/lib/rbac/catalog");
    const { hasPermission } = await import("@/lib/rbac/authorize");
    const pending = await m.applyForLeave(
      teacher2,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(11, 3),
        toDate: monday(11, 3),
      }),
    );
    for (const role of ROLES) {
      const ctx = await ctxFor(
        (await user(`r-${role.key.toLowerCase()}`, role.key)).id,
      );
      const approve = hasPermission(ctx, "leave.approve");
      const anyLeave = approve || hasPermission(ctx, "leave.request");
      // nobody here is linked → apply is always refused
      await expect(
        m.applyForLeave(ctx, req({ leaveTypeId: unpaidId })),
        `${role.key} apply`,
      ).rejects.toBeInstanceOf(m.ForbiddenError);
      if (ctx.isSuperAdmin) {
        await expect(
          m.decideLeave(ctx, {
            id: "missing-request",
            version: 1,
            decision: "APPROVE",
            note: "",
          }),
          role.key,
        ).rejects.toBeInstanceOf(m.NotFoundError);
      } else {
        await expect(
          m.decideLeave(ctx, {
            id: pending.id,
            version: await ver(pending.id),
            decision: "APPROVE",
            note: "",
          }),
          `${role.key} decide`,
        ).rejects.toBeInstanceOf(m.ForbiddenError);
      }
      if (approve)
        expect(
          (await m.listLeaveQueue(ctx, { status: "PENDING", page: 1 })).page,
        ).toBe(1);
      else
        await expect(
          m.listLeaveQueue(ctx, { status: "PENDING", page: 1 }),
          `${role.key} queue`,
        ).rejects.toBeInstanceOf(m.ForbiddenError);
      // cancelling someone else's request: Forbidden without any leave permission; NotFound/Forbidden otherwise — never a write
      await expect(
        m.cancelLeave(ctx, { id: pending.id, version: await ver(pending.id) }),
        `${role.key} cancel`,
      ).rejects.toBeInstanceOf(anyLeave ? m.AppError : m.ForbiddenError);
      if (hasPermission(ctx, "leave.request"))
        expect((await m.getMyLeave(ctx)).linked, `${role.key} my leave`).toBe(
          false,
        );
      else
        await expect(
          m.getMyLeave(ctx),
          `${role.key} my leave`,
        ).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    expect(
      (
        await m.prisma.leaveRequest.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).status,
    ).toBe("PENDING");
  }, 300_000);
  it("audit M1: a weekly-off change after the request refuses the approval (balance and attendance must agree)", async () => {
    const r = await m.applyForLeave(
      teacher2,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(8, 3),
        toDate: monday(8, 3, 5),
      }),
    ); // Mon..Sat = 6
    expect(r.days).toBe("6");
    await m.prisma.schoolSetting.updateMany({
      data: { weeklyOff: { days: [0, 6], saturdays: [] } },
    });
    try {
      await expect(
        m.decideLeave(hr, {
          id: r.id,
          version: await ver(r.id),
          decision: "APPROVE",
          note: "",
        }),
      ).rejects.toBeInstanceOf(m.ConflictError);
    } finally {
      await m.prisma.schoolSetting.updateMany({
        data: { weeklyOff: { days: [0], saturdays: [] } },
      });
    }
    await m.cancelLeave(teacher2, { id: r.id, version: await ver(r.id) });
  });

  it("audit M2/L2: unpaid leave is always charged to a balance and cancel refunds exactly that; a converted ABSENT day goes back to ABSENT", async () => {
    const absentDay = monday(9, 4, 1);
    await m.prisma.employeeAttendance.create({
      data: { employeeId: empSa, date: d(absentDay), status: "ABSENT" },
    });
    const a = await m.applyForLeave(
      superAdmin,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(9, 4),
        toDate: monday(9, 4, 2),
      }),
    ); // 3 days
    await m.decideLeave(hr, {
      id: a.id,
      version: await ver(a.id),
      decision: "APPROVE",
      note: "",
    });
    expect(await used(empSa, unpaidId)).toBe("3"); // zero-allotted balance opened by the approval
    const b = await m.applyForLeave(
      superAdmin,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(9, 5),
        toDate: monday(9, 5, 1),
      }),
    ); // 2 days
    await m.decideLeave(principal, {
      id: b.id,
      version: await ver(b.id),
      decision: "APPROVE",
      note: "",
    });
    expect(await used(empSa, unpaidId)).toBe("5");
    await m.cancelLeave(hr, { id: a.id, version: await ver(a.id) });
    expect(await used(empSa, unpaidId)).toBe("2"); // B's usage intact
    const att = await m.prisma.employeeAttendance.findUniqueOrThrow({
      where: { employeeId_date: { employeeId: empSa, date: d(absentDay) } },
    });
    expect([att.status, att.leaveRequestId]).toEqual(["ABSENT", null]);
    expect(
      await m.prisma.employeeAttendance.count({
        where: { leaveRequestId: a.id },
      }),
    ).toBe(0);
  });

  it("audit L3: a pending request of someone who has left can be rejected but not approved", async () => {
    const r = await m.applyForLeave(
      teacher2,
      req({
        leaveTypeId: unpaidId,
        fromDate: monday(10, 4),
        toDate: monday(10, 4),
      }),
    );
    await m.prisma.employee.update({
      where: { id: empT2 },
      data: {
        employmentStatus: "RESIGNED",
        leavingDate: d(`${Y}-12-31`),
        leavingReason: "Synthetic",
      },
    });
    try {
      await expect(
        m.decideLeave(hr, {
          id: r.id,
          version: await ver(r.id),
          decision: "APPROVE",
          note: "",
        }),
      ).rejects.toBeInstanceOf(m.ConflictError);
      await m.decideLeave(hr, {
        id: r.id,
        version: await ver(r.id),
        decision: "REJECT",
        note: "Synthetic: has left",
      });
    } finally {
      await m.prisma.employee.update({
        where: { id: empT2 },
        data: {
          employmentStatus: "ACTIVE",
          leavingDate: null,
          leavingReason: null,
        },
      });
    }
  });
});
