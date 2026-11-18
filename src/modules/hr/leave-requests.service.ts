import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceBusyError,
  ValidationError,
} from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import {
  authorize,
  authorizeAny,
  hasPermission,
  type AuthContext,
} from "@/lib/rbac/authorize";
import {
  findSessionForDateTx,
  readLeaveCalendarTx,
} from "@/modules/settings/settings.service";
import { assertActorLinked, isOwnRecord } from "./hr.policy";
import { available, classifyRange, leaveDays } from "./leave.rules";
import type {
  ApplyLeaveInput,
  CancelLeaveInput,
  DecideLeaveInput,
  LeaveQueueInput,
} from "./leave.schemas";
import {
  lockedMonthsBetween,
  lockLeaveCalendar,
  setLockTimeout,
  staffHolidaysBetween,
} from "./leave.tx";

/**
 * Phase 3B M3 — leave requests, decisions and cancellation (PHASE_3B_PLAN.md L1, L4–L6, L8–L10; KI-069, KI-071).
 *
 * - Staff apply only for THEMSELVES: the employee is the caller's linked staff record (`ctx.employeeId`), never a
 *   form field (L9). `leave.request` at ALL means "own requests" — enforced here.
 * - Days = working days (weekly off and staff holidays excluded), 0.5 for a half day (L10), computed under the
 *   leave-calendar lock (KI-071) and stored on the request.
 * - Approval (L4, any `leave.approve` holder except the subject — Super Admin included) deducts the balance and
 *   marks the working days ON_LEAVE / HALF_DAY in ONE transaction. Paid leave can't exceed the balance (L5).
 * - Cancellation (L6): the requester while PENDING; an approver for APPROVED leave before its first day (balance
 *   restored, the leave's future attendance rows removed — they were derived from the approval, no day has passed).
 * - Months locked for payroll (L8) refuse every change. Reasons and decision notes never reach audit rows.
 *
 * Lock order: leave.tx.ts.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({
  userId: ctx.userId,
  label: ctx.username,
  ipHash: ctx.ipHash,
  requestId: ctx.requestId,
});
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const stale = () =>
  new ConflictError(
    "This leave request was changed by someone else. Reload the page and try again.",
  );
const busy = (e: unknown): never => {
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};
const LEAVING_STATUSES = new Set(["RESIGNED", "TERMINATED", "RETIRED"]);

function ownEmployeeId(ctx: AuthContext): string {
  if (typeof ctx.employeeId !== "string" || ctx.employeeId === "") {
    throw new ForbiddenError(
      "Your login isn't linked to your staff record yet. Ask a Super Admin to link it, then try again.",
    );
  }
  return ctx.employeeId;
}

async function lockEmployee(tx: Tx, employeeId: string) {
  const [row] = await tx.$queryRaw<
    { staff_type: string; employment_status: string }[]
  >`
    SELECT staff_type::text AS staff_type, employment_status::text AS employment_status
    FROM employee WHERE id = ${employeeId} AND deleted_at IS NULL FOR UPDATE`;
  if (!row) throw new NotFoundError("Employee not found.");
  return row;
}

async function lockRequest(tx: Tx, id: string) {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM leave_request WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Leave request not found.");
  return tx.leaveRequest.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      employeeId: true,
      leaveTypeId: true,
      academicSessionId: true,
      fromDate: true,
      toDate: true,
      halfDay: true,
      days: true,
      status: true,
      requestedById: true,
      version: true,
    },
  });
}

async function shareType(tx: Tx, id: string) {
  const [t] = await tx.$queryRaw<
    {
      code: string;
      is_paid: boolean;
      is_active: boolean;
      allow_half_day: boolean;
      applies_to: string;
    }[]
  >`
    SELECT code, is_paid, is_active, allow_half_day, applies_to::text AS applies_to FROM leave_type WHERE id = ${id} FOR SHARE`;
  return t ?? null;
}

async function shareSession(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM academic_session WHERE id = ${id} FOR SHARE`;
}

async function assertMonthsOpen(tx: Tx, from: string, to: string) {
  const locked = await lockedMonthsBetween(tx, from, to);
  if (locked.length > 0)
    throw new ConflictError(
      `Attendance for ${locked[0].slice(0, 7)} is locked for payroll. Ask HR to correct it instead.`,
    );
}

/** The subject of a request can never decide or cancel-as-approver it (L4, KI-069) — Super Admin included. */
function assertNotSubject(
  ctx: AuthContext,
  req: { employeeId: string; requestedById: string | null },
) {
  if (isOwnRecord(ctx, req.employeeId) || req.requestedById === ctx.userId) {
    throw new ForbiddenError(
      "You can't decide your own leave. Another approver must do it.",
    );
  }
}

// ───────────────────────────── Apply (own leave) ─────────────────────────────

export async function applyForLeave(ctx: AuthContext, input: ApplyLeaveInput) {
  authorize(ctx, "leave.request");
  const employeeId = ownEmployeeId(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockLeaveCalendar(tx);
      const emp = await lockEmployee(tx, employeeId);
      if (LEAVING_STATUSES.has(emp.employment_status))
        throw new ConflictError(
          "Your staff record shows you have left the school.",
        );

      const type = await shareType(tx, input.leaveTypeId);
      const typeError = (message: string) =>
        new ValidationError(message, [{ path: "leaveTypeId", message }]);
      if (!type || !type.is_active) throw typeError("Choose a leave type.");
      if (type.applies_to !== "ALL" && type.applies_to !== emp.staff_type)
        throw typeError("This leave type isn't available to you.");
      if (input.halfDay && !type.allow_half_day)
        throw new ValidationError(
          "This leave type can't be taken as a half day.",
          [{ path: "halfDay", message: "No half days for this type." }],
        );

      const session = await findSessionForDateTx(tx, input.fromDate);
      if (!session)
        throw new ValidationError("No academic session covers the first day.", [
          { path: "fromDate", message: "Outside every academic session." },
        ]);
      if (input.toDate > iso(session.endDate)) {
        throw new ValidationError(
          `Leave can't run past the end of ${session.name}. Apply separately for the next session.`,
          [{ path: "toDate", message: "Past the end of the session." }],
        );
      }
      await shareSession(tx, session.id);
      // Re-read under the row lock: a close committed between the lookup and the lock is seen (audit M3-L1).
      const { session: lockedSession } = await readLeaveCalendarTx(
        tx,
        session.id,
      );
      if (lockedSession.status === "CLOSED")
        throw new ConflictError(`${session.name} is closed.`);
      await assertMonthsOpen(tx, input.fromDate, input.toDate);

      const { weeklyOff } = await readLeaveCalendarTx(tx, session.id);
      const holidays = await staffHolidaysBetween(
        tx,
        input.fromDate,
        input.toDate,
      );
      const days = leaveDays(
        {
          from: input.fromDate,
          to: input.toDate,
          halfDay: input.halfDay !== null,
        },
        weeklyOff,
        holidays,
      );
      if (days.lte(0))
        throw new ValidationError(
          "These dates are all weekly offs or holidays — no leave is needed.",
          [{ path: "fromDate", message: "No working days in the range." }],
        );

      // Overlap with own PENDING / APPROVED leave (serialized by the employee row lock).
      const overlap = await tx.leaveRequest.findFirst({
        where: {
          employeeId,
          status: { in: ["PENDING", "APPROVED"] },
          fromDate: { lte: day(input.toDate) },
          toDate: { gte: day(input.fromDate) },
        },
        select: { fromDate: true, toDate: true },
      });
      if (overlap)
        throw new ConflictError(
          `You already have leave from ${iso(overlap.fromDate)} to ${iso(overlap.toDate)} that overlaps these dates.`,
        );

      if (type.is_paid) {
        // L5: available minus what is already requested and pending for this type and session.
        const balance = await tx.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_academicSessionId: {
              employeeId,
              leaveTypeId: input.leaveTypeId,
              academicSessionId: session.id,
            },
          },
          select: { allotted: true, carriedForward: true, used: true },
        });
        const pending = await tx.leaveRequest.aggregate({
          where: {
            employeeId,
            leaveTypeId: input.leaveTypeId,
            academicSessionId: session.id,
            status: "PENDING",
          },
          _sum: { days: true },
        });
        const free = balance
          ? available(balance).minus(pending._sum.days ?? 0)
          : new Decimal(0);
        if (free.lt(days)) {
          throw new ValidationError(
            `Only ${Decimal.max(free, 0).toString()} day(s) of this leave are left (after pending requests); these dates need ${days.toString()}. Apply the rest as unpaid leave.`,
            [{ path: "leaveTypeId", message: "Not enough balance." }],
          );
        }
      }

      const created = await tx.leaveRequest.create({
        data: {
          employeeId,
          leaveTypeId: input.leaveTypeId,
          academicSessionId: session.id,
          fromDate: day(input.fromDate),
          toDate: day(input.toDate),
          halfDay: input.halfDay,
          days,
          reason: input.reason,
          requestedById: ctx.userId,
        },
        select: { id: true, days: true },
      });
      await audit(tx, actorOf(ctx), {
        action: "leave_request.create",
        entityType: "LeaveRequest",
        entityId: created.id,
        after: {
          employeeId,
          leaveType: type.code,
          academicSessionId: session.id,
          fromDate: input.fromDate,
          toDate: input.toDate,
          halfDay: input.halfDay,
          days: days.toString(),
          status: "PENDING",
        },
      });
      return { id: created.id, days: created.days.toString() };
    });
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Decide (approve / reject) ─────────────────────────────

export async function decideLeave(ctx: AuthContext, input: DecideLeaveInput) {
  authorize(ctx, "leave.approve");
  assertActorLinked(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockLeaveCalendar(tx);
      const peek = await tx.leaveRequest.findUnique({
        where: { id: input.id },
        select: { employeeId: true },
      });
      if (!peek) throw new NotFoundError("Leave request not found.");
      const subject = await lockEmployee(tx, peek.employeeId);
      const req = await lockRequest(tx, input.id);
      assertNotSubject(ctx, req);
      if (
        input.decision === "APPROVE" &&
        LEAVING_STATUSES.has(subject.employment_status)
      )
        throw new ConflictError(
          "This employee has left the school. Reject the request instead.",
        );
      if (req.version !== input.version) throw stale();
      if (req.status !== "PENDING")
        throw new ConflictError(
          "This request has already been decided or cancelled.",
        );
      const type = await shareType(tx, req.leaveTypeId);
      if (!type) throw new NotFoundError("Leave type not found.");
      const from = iso(req.fromDate);
      const to = iso(req.toDate);
      const decided = {
        decidedById: ctx.userId,
        decidedAt: new Date(),
        decisionNote: input.note === "" ? null : input.note,
        version: { increment: 1 },
      };

      if (input.decision === "REJECT") {
        const r = await tx.leaveRequest.updateMany({
          where: { id: req.id, version: req.version },
          data: { status: "REJECTED", ...decided },
        });
        if (r.count !== 1) throw stale();
        await audit(tx, actorOf(ctx), {
          action: "leave_request.reject",
          entityType: "LeaveRequest",
          entityId: req.id,
          before: { status: "PENDING" },
          after: {
            status: "REJECTED",
            employeeId: req.employeeId,
            leaveType: type.code,
            days: req.days.toString(),
          },
        });
        return;
      }

      await shareSession(tx, req.academicSessionId);
      const { session, weeklyOff } = await readLeaveCalendarTx(
        tx,
        req.academicSessionId,
      );
      if (session.status === "CLOSED")
        throw new ConflictError(`${session.name} is closed.`);
      await assertMonthsOpen(tx, from, to);

      // Balance (L5): paid leave needs enough; unpaid leave counts as used where a balance exists.
      const balance = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_academicSessionId: {
            employeeId: req.employeeId,
            leaveTypeId: req.leaveTypeId,
            academicSessionId: req.academicSessionId,
          },
        },
        select: {
          id: true,
          allotted: true,
          carriedForward: true,
          used: true,
          version: true,
        },
      });
      if (type.is_paid && (!balance || available(balance).lt(req.days))) {
        throw new ConflictError(
          `Not enough ${type.code} balance left (${balance ? available(balance).toString() : "0"} day(s)) for ${req.days.toString()} day(s). Ask the employee to apply the rest as unpaid leave.`,
        );
      }

      // Attendance: every working day becomes ON_LEAVE (HALF_DAY for a half day). An already-marked ABSENT day is
      // converted; a day marked present/late (or otherwise) must be corrected first — never silently overwritten.
      const holidays = await staffHolidaysBetween(tx, from, to);
      const working = classifyRange(from, to, weeklyOff, holidays)
        .filter((d) => d.kind === "working")
        .map((d) => d.date);
      // Audit M3-M1: the weekly off may have changed since the request. Balance (stored days) and attendance
      // (current calendar) must agree, so a changed count refuses the approval — the employee re-applies.
      const expected = req.halfDay
        ? new Decimal(working.length === 1 ? "0.5" : 0)
        : new Decimal(working.length);
      if (!expected.eq(req.days))
        throw new ConflictError(
          `The school calendar changed after this request (it now covers ${expected.toString()} working day(s), not ${req.days.toString()}). Ask the employee to withdraw it and apply again.`,
        );
      const status = req.halfDay
        ? ("HALF_DAY" as const)
        : ("ON_LEAVE" as const);
      const existing = await tx.employeeAttendance.findMany({
        where: { employeeId: req.employeeId, date: { in: working.map(day) } },
        select: { id: true, date: true, status: true, leaveRequestId: true },
      });
      const blocked = existing.find(
        (a) => a.status !== "ABSENT" || a.leaveRequestId !== null,
      );
      if (blocked)
        throw new ConflictError(
          `Attendance for ${iso(blocked.date)} is already recorded as ${blocked.status.toLowerCase().replace("_", " ")}. Correct it first, then approve.`,
        );
      if (existing.length > 0) {
        await tx.employeeAttendance.updateMany({
          where: { id: { in: existing.map((a) => a.id) } },
          data: {
            status,
            leaveRequestId: req.id,
            markedById: ctx.userId,
            version: { increment: 1 },
          },
        });
      }
      const taken = new Set(existing.map((a) => iso(a.date)));
      const fresh = working.filter((d) => !taken.has(d));
      if (fresh.length > 0) {
        await tx.employeeAttendance.createMany({
          data: fresh.map((d) => ({
            employeeId: req.employeeId,
            date: day(d),
            status,
            leaveRequestId: req.id,
            markedById: ctx.userId,
          })),
        });
      }

      let balanceAudit: Record<string, string> | null = null;
      if (!balance) {
        // Unpaid type without a balance (paid types were refused above): open a zero-allotted one so every
        // approval is charged to a balance and a later cancellation refunds exactly what was charged (audit M3-M2).
        await tx.leaveBalance.create({
          data: {
            employeeId: req.employeeId,
            leaveTypeId: req.leaveTypeId,
            academicSessionId: req.academicSessionId,
            used: req.days,
          },
        });
        balanceAudit = {
          usedBefore: "0",
          usedAfter: req.days.toString(),
          opened: "true",
        };
      } else {
        const used = new Decimal(balance.used).plus(req.days);
        const b = await tx.leaveBalance.updateMany({
          where: { id: balance.id, version: balance.version },
          data: { used, version: { increment: 1 } },
        });
        if (b.count !== 1) throw stale();
        balanceAudit = {
          usedBefore: balance.used.toString(),
          usedAfter: used.toString(),
        };
      }
      const r = await tx.leaveRequest.updateMany({
        where: { id: req.id, version: req.version },
        data: { status: "APPROVED", ...decided },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "leave_request.approve",
        entityType: "LeaveRequest",
        entityId: req.id,
        before: { status: "PENDING" },
        after: {
          status: "APPROVED",
          employeeId: req.employeeId,
          leaveType: type.code,
          fromDate: from,
          toDate: to,
          days: req.days.toString(),
          attendanceDays: working.length,
          convertedAbsentDays: existing.length,
          balance: balanceAudit,
        },
      });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Cancel (L6) ─────────────────────────────

export async function cancelLeave(ctx: AuthContext, input: CancelLeaveInput) {
  authorizeAny(ctx, ["leave.request", "leave.approve"]);
  try {
    await prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      await lockLeaveCalendar(tx);
      const peek = await tx.leaveRequest.findUnique({
        where: { id: input.id },
        select: { employeeId: true },
      });
      if (!peek) throw new NotFoundError("Leave request not found.");
      const own = isOwnRecord(ctx, peek.employeeId);
      // Neither the subject nor an approver → the request doesn't exist for this caller (no existence oracle).
      if (!own && !hasPermission(ctx, "leave.approve"))
        throw new NotFoundError("Leave request not found.");
      await lockEmployee(tx, peek.employeeId);
      const req = await lockRequest(tx, input.id);
      if (req.version !== input.version) throw stale();
      const type = await shareType(tx, req.leaveTypeId);
      const base = {
        employeeId: req.employeeId,
        leaveType: type?.code ?? null,
        days: req.days.toString(),
      };

      if (req.status === "PENDING") {
        if (!own || !hasPermission(ctx, "leave.request"))
          throw new ForbiddenError(
            "Only the employee can withdraw a pending request. Reject it instead.",
          );
        const r = await tx.leaveRequest.updateMany({
          where: { id: req.id, version: req.version },
          data: { status: "CANCELLED", version: { increment: 1 } },
        });
        if (r.count !== 1) throw stale();
        await audit(tx, actorOf(ctx), {
          action: "leave_request.withdraw",
          entityType: "LeaveRequest",
          entityId: req.id,
          before: { status: "PENDING" },
          after: { status: "CANCELLED", ...base },
        });
        return;
      }
      if (req.status !== "APPROVED")
        throw new ConflictError("This request is no longer active.");

      authorize(ctx, "leave.approve");
      assertActorLinked(ctx);
      assertNotSubject(ctx, req);
      const { timezone } = await readLeaveCalendarTx(tx, req.academicSessionId);
      const today = todayInTimeZone(timezone ?? undefined);
      if (iso(req.fromDate) <= today)
        throw new ConflictError(
          "This leave has already started. Correct the attendance instead of cancelling.",
        );
      await assertMonthsOpen(tx, iso(req.fromDate), iso(req.toDate));

      const balance = await tx.leaveBalance.findUnique({
        where: {
          employeeId_leaveTypeId_academicSessionId: {
            employeeId: req.employeeId,
            leaveTypeId: req.leaveTypeId,
            academicSessionId: req.academicSessionId,
          },
        },
        select: { id: true, used: true, version: true },
      });
      let balanceAudit: Record<string, string> | null = null;
      if (balance) {
        const used = new Decimal(balance.used).minus(req.days);
        if (used.isNegative())
          throw new ConflictError(
            "The balance doesn't match this leave any more. Ask HR to check the balance first.",
          );
        const b = await tx.leaveBalance.updateMany({
          where: { id: balance.id, version: balance.version },
          data: { used, version: { increment: 1 } },
        });
        if (b.count !== 1) throw stale();
        balanceAudit = {
          usedBefore: balance.used.toString(),
          usedAfter: used.toString(),
        };
      }
      // The leave hasn't started. Rows the approval CREATED (version 1) are removed; rows it CONVERTED from ABSENT
      // (version > 1) go back to ABSENT (audit M3-L2).
      const restored = await tx.employeeAttendance.updateMany({
        where: { leaveRequestId: req.id, version: { gt: 1 } },
        data: {
          status: "ABSENT",
          leaveRequestId: null,
          markedById: ctx.userId,
          version: { increment: 1 },
        },
      });
      const removed = await tx.employeeAttendance.deleteMany({
        where: { leaveRequestId: req.id },
      });
      const r = await tx.leaveRequest.updateMany({
        where: { id: req.id, version: req.version },
        data: { status: "CANCELLED", version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), {
        action: "leave_request.cancel",
        entityType: "LeaveRequest",
        entityId: req.id,
        before: { status: "APPROVED" },
        after: {
          status: "CANCELLED",
          ...base,
          attendanceRowsRemoved: removed.count,
          attendanceRowsRestoredAbsent: restored.count,
          balance: balanceAudit,
        },
      });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Reads ─────────────────────────────

/** "My leave" (L9): own balances, own requests (with reasons and decision notes) and the types one may apply for. */
export async function getMyLeave(ctx: AuthContext, academicSessionId?: string) {
  authorize(ctx, "leave.request");
  if (typeof ctx.employeeId !== "string" || ctx.employeeId === "")
    return { linked: false as const };
  const employeeId = ctx.employeeId;
  return prisma.$transaction(async (tx) => {
    const emp = await tx.employee.findFirst({
      where: { id: employeeId, deletedAt: null },
      select: { staffType: true },
    });
    if (!emp) return { linked: false as const };
    const setting = await tx.schoolSetting.findFirst({
      select: { currentAcademicSessionId: true, timezone: true },
    });
    const sessionId =
      academicSessionId ?? setting?.currentAcademicSessionId ?? null;
    const session = sessionId
      ? await tx.academicSession.findUnique({
          where: { id: sessionId },
          select: {
            id: true,
            name: true,
            startDate: true,
            endDate: true,
            status: true,
          },
        })
      : null;
    const [balances, requests, types] = await Promise.all([
      session
        ? tx.leaveBalance.findMany({
            where: { employeeId, academicSessionId: session.id },
            orderBy: { leaveType: { name: "asc" } },
            take: 100,
            select: {
              id: true,
              allotted: true,
              carriedForward: true,
              used: true,
              leaveType: {
                select: { id: true, code: true, name: true, isPaid: true },
              },
            },
          })
        : Promise.resolve([]),
      tx.leaveRequest.findMany({
        where: {
          employeeId,
          ...(session ? { academicSessionId: session.id } : {}),
        },
        orderBy: [{ fromDate: "desc" }, { id: "desc" }],
        take: 100,
        select: {
          id: true,
          version: true,
          fromDate: true,
          toDate: true,
          halfDay: true,
          days: true,
          reason: true,
          status: true,
          decisionNote: true,
          decidedAt: true,
          createdAt: true,
          leaveType: { select: { code: true, name: true, isPaid: true } },
        },
      }),
      tx.leaveType.findMany({
        where: { isActive: true, appliesTo: { in: ["ALL", emp.staffType] } },
        orderBy: { name: "asc" },
        take: 200,
        select: {
          id: true,
          code: true,
          name: true,
          isPaid: true,
          allowHalfDay: true,
        },
      }),
    ]);
    return {
      linked: true as const,
      session,
      balances,
      requests,
      types,
      today: todayInTimeZone(setting?.timezone ?? undefined),
    };
  });
}

const QUEUE_PAGE_SIZE = 25;

/**
 * Approval queue (L4): requests of OTHER staff (the caller's own are in "My leave" and can't be decided by them).
 * Approvers see the reason — they need it to decide. Staff who report to the caller are listed first on each page.
 */
export async function listLeaveQueue(ctx: AuthContext, input: LeaveQueueInput) {
  authorize(ctx, "leave.approve");
  const own =
    typeof ctx.employeeId === "string" && ctx.employeeId !== ""
      ? ctx.employeeId
      : null;
  const where = {
    status: input.status,
    employee: { deletedAt: null },
    ...(own ? { employeeId: { not: own } } : {}),
    OR: [{ requestedById: null }, { requestedById: { not: ctx.userId } }],
  };
  const [total, rows, setting] = await Promise.all([
    prisma.leaveRequest.count({ where }),
    prisma.leaveRequest.findMany({
      where,
      orderBy:
        input.status === "PENDING"
          ? [{ fromDate: "asc" }, { id: "asc" }]
          : [{ updatedAt: "desc" }, { id: "desc" }],
      skip: (input.page - 1) * QUEUE_PAGE_SIZE,
      take: QUEUE_PAGE_SIZE,
      select: {
        id: true,
        version: true,
        employeeId: true,
        leaveTypeId: true,
        academicSessionId: true,
        fromDate: true,
        toDate: true,
        halfDay: true,
        days: true,
        reason: true,
        status: true,
        decisionNote: true,
        decidedAt: true,
        createdAt: true,
        leaveType: { select: { code: true, name: true, isPaid: true } },
        employee: {
          select: {
            employeeCode: true,
            fullName: true,
            reportsToId: true,
            department: { select: { name: true } },
            designation: { select: { name: true } },
          },
        },
        decidedBy: { select: { displayName: true } },
      },
    }),
    prisma.schoolSetting.findFirst({ select: { timezone: true } }),
  ]);
  const balances = rows.length
    ? await prisma.leaveBalance.findMany({
        where: {
          OR: rows.map((r) => ({
            employeeId: r.employeeId,
            leaveTypeId: r.leaveTypeId,
            academicSessionId: r.academicSessionId,
          })),
        },
        select: {
          employeeId: true,
          leaveTypeId: true,
          academicSessionId: true,
          allotted: true,
          carriedForward: true,
          used: true,
        },
      })
    : [];
  const key = (r: {
    employeeId: string;
    leaveTypeId: string;
    academicSessionId: string;
  }) => `${r.employeeId}|${r.leaveTypeId}|${r.academicSessionId}`;
  const byKey = new Map(balances.map((b) => [key(b), available(b).toString()]));
  const items = rows
    .map((r) => ({
      ...r,
      reportsToMe: own !== null && r.employee.reportsToId === own,
      available: byKey.get(key(r)) ?? null,
    }))
    .sort((a, b) => Number(b.reportsToMe) - Number(a.reportsToMe));
  return {
    items,
    total,
    page: input.page,
    pageSize: QUEUE_PAGE_SIZE,
    today: todayInTimeZone(setting?.timezone ?? undefined),
  };
}
