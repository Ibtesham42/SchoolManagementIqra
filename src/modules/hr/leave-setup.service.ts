import { studentAttendanceCountOnTx } from "@/modules/students/students.tx";
import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceBusyError,
  ValidationError,
} from "@/lib/errors";
import {
  authorize,
  authorizeAny,
  hasPermission,
  type AuthContext,
} from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { readLeaveCalendarTx } from "@/modules/settings/settings.service";
import {
  assertActorLinked,
  employeeReadAccess,
  employeeRecordAccess,
  isOwnRecord,
} from "./hr.policy";
import { masterNameKeyOf } from "./hr.rules";
import { STAFF_HOLIDAY_SCOPES } from "./leave.rules";
import { lockedMonthsBetween, lockLeaveCalendar } from "./leave.tx";
import type {
  CreateHolidayInput,
  CreateLeaveTypeInput,
  OpeningBalanceInput,
  SetLeaveTypeActiveInput,
  UpdateLeaveTypeInput,
} from "./leave.schemas";

/**
 * Phase 3B M2 — leave set-up (PHASE_3B_PLAN.md; owner decisions L1–L3, L5): school-defined leave types, the holiday
 * calendar, and opening leave balances per academic session. Writes need `employee.manage`; every write is one short
 * transaction with row locks, lock_timeout 5 s and audit in the same transaction. Leave reasons and remarks are never
 * involved here; audit rows carry codes, ids, dates and day counts.
 *
 * Lock order: see leave.tx.ts (calendar advisory lock → employee → leave_request → leave_type → session → balance).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({
  userId: ctx.userId,
  label: ctx.username,
  ipHash: ctx.ipHash,
  requestId: ctx.requestId,
});
const parseDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const stale = (what: string) =>
  new ConflictError(
    `This ${what} was changed by someone else. Reload the page and try again.`,
  );

async function lockTimeout(tx: Tx) {
  await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
}
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

// ───────────────────────────── Leave types (L2) ─────────────────────────────

const LEAVE_TYPE_SELECT = {
  id: true,
  code: true,
  name: true,
  isPaid: true,
  annualQuota: true,
  allowHalfDay: true,
  carryForwardMax: true,
  appliesTo: true,
  isActive: true,
  version: true,
} satisfies Prisma.LeaveTypeSelect;

/** Readable by staff who manage, approve or request leave (the request form needs the list in M3). */
export async function listLeaveTypes(
  ctx: AuthContext,
  opts: { includeInactive?: boolean } = {},
) {
  authorizeAny(ctx, ["employee.read", "leave.request", "leave.approve"]);
  // Usage counts would reveal how many staff hold or requested a type (e.g. medical leave): only managers learn
  // whether a type is in use, and only as a yes/no that decides which fields stay editable.
  const manager = hasPermission(ctx, "employee.manage");
  const rows = await prisma.leaveType.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: 200,
    select: {
      ...LEAVE_TYPE_SELECT,
      _count: { select: { requests: true, balances: true } },
    },
  });
  return rows.map(({ _count, ...t }) => ({
    ...t,
    inUse: manager ? _count.requests + _count.balances > 0 : null,
  }));
}

function mapLeaveTypeConflict(
  e: unknown,
  input?: { code: string; name: string },
): never {
  if (input && isUniqueViolation(e, "code"))
    throw new ConflictError(
      `A leave type with code ${input.code} already exists.`,
    );
  if (input && isUniqueViolation(e, "nameKey"))
    throw new ConflictError(
      `A leave type named "${input.name}" already exists.`,
    );
  return busy(e);
}

const typeData = (i: CreateLeaveTypeInput) => ({
  code: i.code,
  name: i.name,
  nameKey: masterNameKeyOf(i.name),
  isPaid: i.isPaid,
  annualQuota: i.annualQuota === null ? null : new Decimal(i.annualQuota),
  allowHalfDay: i.allowHalfDay,
  carryForwardMax: new Decimal(i.carryForwardMax),
  appliesTo: i.appliesTo,
});
const typeAudit = (i: CreateLeaveTypeInput) => ({
  code: i.code,
  name: i.name,
  isPaid: i.isPaid,
  annualQuota: i.annualQuota,
  allowHalfDay: i.allowHalfDay,
  carryForwardMax: i.carryForwardMax,
  appliesTo: i.appliesTo,
});

export async function createLeaveType(
  ctx: AuthContext,
  input: CreateLeaveTypeInput,
) {
  authorize(ctx, "employee.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const created = await tx.leaveType.create({
        data: typeData(input),
        select: LEAVE_TYPE_SELECT,
      });
      await audit(tx, actorOf(ctx), {
        action: "leave_type.create",
        entityType: "LeaveType",
        entityId: created.id,
        after: { ...typeAudit(input), isActive: true },
      });
      return created;
    });
  } catch (e) {
    mapLeaveTypeConflict(e, input);
  }
}

async function lockLeaveType(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM leave_type WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Leave type not found.");
  return tx.leaveType.findUniqueOrThrow({
    where: { id },
    select: {
      ...LEAVE_TYPE_SELECT,
      _count: { select: { requests: true, balances: true } },
    },
  });
}

/**
 * Once a type is used (balances or requests), its code, paid/unpaid nature and who it applies to are fixed (they
 * drive payroll and existing balances); its name, quota, half-day and carry-forward rules may still change.
 */
export async function updateLeaveType(
  ctx: AuthContext,
  input: UpdateLeaveTypeInput,
) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockLeaveType(tx, input.id);
      if (current.version !== input.version) throw stale("leave type");
      const used = current._count.requests + current._count.balances > 0;
      if (
        used &&
        (current.code !== input.code ||
          current.isPaid !== input.isPaid ||
          current.appliesTo !== input.appliesTo)
      ) {
        throw new ConflictError(
          "This leave type is in use: its code, paid/unpaid setting and who it applies to can't change. Create a new type instead.",
        );
      }
      const before = {
        code: current.code,
        name: current.name,
        isPaid: current.isPaid,
        annualQuota: current.annualQuota?.toString() ?? null,
        allowHalfDay: current.allowHalfDay,
        carryForwardMax: current.carryForwardMax.toString(),
        appliesTo: current.appliesTo,
      };
      const after = typeAudit(input);
      if (JSON.stringify(before) === JSON.stringify(after)) return;
      const r = await tx.leaveType.updateMany({
        where: { id: input.id, version: input.version },
        data: { ...typeData(input), version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("leave type");
      await audit(tx, actorOf(ctx), {
        action: "leave_type.update",
        entityType: "LeaveType",
        entityId: input.id,
        before: { ...before, version: current.version },
        after: { ...after, version: current.version + 1 },
      });
    });
  } catch (e) {
    mapLeaveTypeConflict(e, input);
  }
}

export async function setLeaveTypeActive(
  ctx: AuthContext,
  input: SetLeaveTypeActiveInput,
) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const current = await lockLeaveType(tx, input.id);
      if (current.version !== input.version) throw stale("leave type");
      if (current.isActive === input.active) return;
      const r = await tx.leaveType.updateMany({
        where: { id: input.id, version: input.version },
        data: { isActive: input.active, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("leave type");
      await audit(tx, actorOf(ctx), {
        action: "leave_type.status_change",
        entityType: "LeaveType",
        entityId: input.id,
        before: { isActive: current.isActive },
        after: { isActive: input.active },
      });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Holidays (school calendar) ─────────────────────────────

/** Holidays within an academic session (not sensitive — any staff member who deals with leave or staff records). */
export async function listHolidays(
  ctx: AuthContext,
  academicSessionId: string,
) {
  authorizeAny(ctx, [
    "employee.read",
    "leave.request",
    "leave.approve",
    "attendance.employee.read",
  ]);
  return prisma.$transaction(async (tx) => {
    const { session } = await readLeaveCalendarTx(tx, academicSessionId);
    return tx.holiday.findMany({
      where: { date: { gte: session.startDate, lte: session.endDate } },
      orderBy: [{ date: "asc" }, { appliesTo: "asc" }],
      take: 400,
      select: { id: true, date: true, name: true, appliesTo: true },
    });
  });
}

/** A staff holiday on a date that pending/approved leave already covers would silently change those requests' days. */
async function assertNoLeaveOn(tx: Tx, date: Date) {
  const n = await tx.leaveRequest.count({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
      fromDate: { lte: date },
      toDate: { gte: date },
    },
  });
  if (n > 0)
    throw new ConflictError(
      `${n} leave request${n === 1 ? "" : "s"} already cover${n === 1 ? "s" : ""} this date. Cancel or decide them first, then change the calendar.`,
    );
}

export async function createHoliday(
  ctx: AuthContext,
  input: CreateHolidayInput,
) {
  authorize(ctx, "employee.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockLeaveCalendar(tx); // KI-071: serialized with leave apply/approve/cancel
      const date = parseDate(input.date);
      if (STAFF_HOLIDAY_SCOPES.includes(input.appliesTo))
        await assertNoLeaveOn(tx, date);
      // Review 3C-M4 L2: a staff holiday can't change a month that payroll has locked.
      if (STAFF_HOLIDAY_SCOPES.includes(input.appliesTo) && (await lockedMonthsBetween(tx, input.date, input.date)).length > 0)
        throw new ConflictError(`Payroll for ${input.date.slice(0, 7)} is approved, so its staff calendar is locked.`);
      // Phase 4A: a holiday for students can't fall on a day whose student attendance is already recorded.
      if (input.appliesTo !== "STAFF" && (await studentAttendanceCountOnTx(tx, date)) > 0)
        throw new ConflictError("Student attendance is already recorded for this date. Correct it before adding a holiday.");
      const created = await tx.holiday.create({
        data: {
          date,
          name: input.name,
          appliesTo: input.appliesTo,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      await audit(tx, actorOf(ctx), {
        action: "holiday.create",
        entityType: "Holiday",
        entityId: created.id,
        after: {
          date: input.date,
          name: input.name,
          appliesTo: input.appliesTo,
        },
      });
      return created;
    });
  } catch (e) {
    if (isUniqueViolation(e))
      throw new ConflictError(
        "A holiday for the same people already exists on that date.",
      );
    return busy(e);
  }
}

/** Calendar entries are configuration (not people or money) — removed outright, audited; refused once used. */
export async function removeHoliday(ctx: AuthContext, id: string) {
  authorize(ctx, "employee.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      await lockLeaveCalendar(tx); // KI-071: serialized with leave apply/approve/cancel
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM holiday WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Holiday not found.");
      const h = await tx.holiday.findUniqueOrThrow({
        where: { id },
        select: { date: true, name: true, appliesTo: true },
      });
      if (STAFF_HOLIDAY_SCOPES.includes(h.appliesTo)) {
        if ((await lockedMonthsBetween(tx, isoDate(h.date), isoDate(h.date))).length > 0)
          throw new ConflictError(`Payroll for ${isoDate(h.date).slice(0, 7)} is approved, so its staff calendar is locked.`);
        await assertNoLeaveOn(tx, h.date);
        if (
          (await tx.employeeAttendance.count({
            where: { date: h.date, status: "HOLIDAY" },
          })) > 0
        )
          throw new ConflictError(
            "Attendance has already been recorded for this holiday.",
          );
      }
      await tx.holiday.delete({ where: { id } });
      await audit(tx, actorOf(ctx), {
        action: "holiday.remove",
        entityType: "Holiday",
        entityId: id,
        before: { date: isoDate(h.date), name: h.name, appliesTo: h.appliesTo },
      });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Opening balances (L1, L5) ─────────────────────────────

/** Balances of one employee in one session — personal tier on the record (ALL, or SELF on the own record). */
export async function listLeaveBalances(
  ctx: AuthContext,
  employeeId: string,
  academicSessionId: string,
) {
  const { tier } = employeeRecordAccess(ctx, employeeId);
  if (tier !== "personal") return null;
  return prisma.leaveBalance.findMany({
    where: { employeeId, academicSessionId, employee: { deletedAt: null } },
    orderBy: { leaveType: { name: "asc" } },
    take: 100,
    select: {
      id: true,
      version: true,
      allotted: true,
      carriedForward: true,
      used: true,
      leaveType: { select: { id: true, code: true, name: true, isPaid: true } },
    },
  });
}

/**
 * Set (create or correct) an opening balance. The type must apply to the employee's staff type; the session must not
 * be CLOSED; allotted + carried forward can't drop below what has already been used.
 */
export async function setOpeningBalance(
  ctx: AuthContext,
  input: OpeningBalanceInput,
) {
  authorize(ctx, "employee.manage");
  // Balances sit in the personal tier (listLeaveBalances): writing them needs that tier too.
  if (employeeReadAccess(ctx).tier !== "personal")
    throw new NotFoundError("Employee not found.");
  // KI-069 (approver ≠ subject): the actor must be identifiable as staff and may not set their own balance.
  assertActorLinked(ctx);
  if (!ctx.isSuperAdmin && isOwnRecord(ctx, input.employeeId))
    throw new ForbiddenError(
      "You can't set your own leave balance. Ask another HR administrator.",
    );
  try {
    await prisma.$transaction(async (tx) => {
      await lockTimeout(tx);
      const emp = await tx.$queryRaw<
        { staff_type: string }[]
      >`SELECT staff_type::text AS staff_type FROM employee WHERE id = ${input.employeeId} AND deleted_at IS NULL FOR UPDATE`;
      if (emp.length === 0) throw new NotFoundError("Employee not found.");
      // FOR SHARE: a concurrent edit/deactivation of the type waits, so its "in use" check sees this balance.
      const typeRows = await tx.$queryRaw<
        { applies_to: string; is_active: boolean; code: string }[]
      >`SELECT applies_to::text AS applies_to, is_active, code FROM leave_type WHERE id = ${input.leaveTypeId} FOR SHARE`;
      const type = typeRows[0]
        ? {
            appliesTo: typeRows[0].applies_to,
            isActive: typeRows[0].is_active,
            code: typeRows[0].code,
          }
        : null;
      if (!type)
        throw new ValidationError("Choose a leave type.", [
          { path: "leaveTypeId", message: "Choose a leave type." },
        ]);
      if (type.appliesTo !== "ALL" && type.appliesTo !== emp[0].staff_type)
        throw new ValidationError(
          "This leave type doesn't apply to this employee's staff type.",
          [{ path: "leaveTypeId", message: "Not for this staff type." }],
        );
      // FOR SHARE: a concurrent close of the session waits for this write (and then sees the balance).
      await tx.$queryRaw`SELECT id FROM academic_session WHERE id = ${input.academicSessionId} FOR SHARE`;
      const { session } = await readLeaveCalendarTx(
        tx,
        input.academicSessionId,
      );
      if (session.status === "CLOSED")
        throw new ConflictError(
          "Balances of a closed academic session can't change.",
        );

      const allotted = new Decimal(input.allotted);
      const carriedForward = new Decimal(input.carriedForward);
      const existing = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_academicSessionId: {
            employeeId: input.employeeId,
            leaveTypeId: input.leaveTypeId,
            academicSessionId: input.academicSessionId,
          },
        },
        select: {
          id: true,
          version: true,
          allotted: true,
          carriedForward: true,
          used: true,
        },
      });
      if (!existing) {
        if (input.version !== null) throw stale("balance");
        if (!type.isActive)
          throw new ValidationError("This leave type is inactive.", [
            { path: "leaveTypeId", message: "Inactive leave type." },
          ]);
        const b = await tx.leaveBalance.create({
          data: {
            employeeId: input.employeeId,
            leaveTypeId: input.leaveTypeId,
            academicSessionId: input.academicSessionId,
            allotted,
            carriedForward,
          },
          select: { id: true },
        });
        await audit(tx, actorOf(ctx), {
          action: "leave_balance.open",
          entityType: "LeaveBalance",
          entityId: b.id,
          after: {
            employeeId: input.employeeId,
            leaveType: type.code,
            academicSessionId: input.academicSessionId,
            allotted: allotted.toString(),
            carriedForward: carriedForward.toString(),
          },
        });
        return;
      }
      if (input.version !== existing.version) throw stale("balance");
      if (allotted.plus(carriedForward).lt(existing.used)) {
        throw new ValidationError(
          `Already ${existing.used.toString()} day(s) used — the balance can't be lower than that.`,
          [{ path: "allotted", message: "Below the days already used." }],
        );
      }
      if (
        allotted.eq(existing.allotted) &&
        carriedForward.eq(existing.carriedForward)
      )
        return;
      const r = await tx.leaveBalance.updateMany({
        where: { id: existing.id, version: existing.version },
        data: { allotted, carriedForward, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale("balance");
      await audit(tx, actorOf(ctx), {
        action: "leave_balance.adjust",
        entityType: "LeaveBalance",
        entityId: existing.id,
        before: {
          allotted: existing.allotted.toString(),
          carriedForward: existing.carriedForward.toString(),
          version: existing.version,
        },
        after: {
          allotted: allotted.toString(),
          carriedForward: carriedForward.toString(),
          version: existing.version + 1,
        },
      });
    });
  } catch (e) {
    busy(e);
  }
}
