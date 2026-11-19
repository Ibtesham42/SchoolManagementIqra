import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorize, hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { assertActorLinked, isOwnRecord } from "@/modules/hr/hr.policy";
import { readPayrollSettingsTx } from "@/modules/settings/settings.service";
import { lockPayroll } from "./payroll.tx";
import type { AddAdjustmentInput, BulkPaymentInput, RecordPaymentInput } from "./slips.schemas";

/**
 * Phase 3C-M5 — slip adjustments (P10), salary payments (P13) and own slips (P12).
 *
 * - Adjustments: `payroll.prepare`, only while the run is PREPARED, never on the actor's own slip. They take effect at
 *   the next prepare — approval recomputes the slips and refuses until the run is prepared again. Amounts and notes are
 *   never audited (rule 10).
 * - Payments: `payroll.pay` (Accountant), only for APPROVED / PAID runs, never the actor's own slip, never more than the
 *   slip's net (sum of payments); references unique per method; the run becomes PAID when every slip is fully paid.
 * - Own slips: `salary.self.read` SELF → the caller's linked staff record, approved / paid runs only. `payroll.read`
 *   holders read any slip.
 * Lock order: payroll (advisory) → payroll_run (UPDATE / SHARE) → payroll_slip (UPDATE).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("This payment reference is already recorded for that method.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

async function lockSlip(tx: Tx, slipId: string) {
  const peek = await tx.payrollSlip.findUnique({ where: { id: slipId }, select: { runId: true } });
  if (!peek) throw new NotFoundError("Salary slip not found.");
  const [run] = await tx.$queryRaw<{ id: string; status: string }[]>`SELECT id, status::text AS status FROM payroll_run WHERE id = ${peek.runId} FOR UPDATE`;
  const [slip] = await tx.$queryRaw<{ id: string; employee_id: string; net: string; slip_no: string | null }[]>`
    SELECT id, employee_id, net::text AS net, slip_no FROM payroll_slip WHERE id = ${slipId} FOR UPDATE`;
  if (!run || !slip) throw new NotFoundError("Salary slip not found.");
  return { run, slip };
}

// ───────────────────────────── Adjustments (P10) ─────────────────────────────

export async function addAdjustment(ctx: AuthContext, input: AddAdjustmentInput) {
  authorize(ctx, "payroll.prepare");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPayroll(tx);
      const { run, slip } = await lockSlip(tx, input.slipId);
      if (isOwnRecord(ctx, slip.employee_id)) throw new ForbiddenError("You can't adjust your own salary slip.");
      if (run.status !== "PREPARED") throw new ConflictError("Adjustments can only be added while the payroll is prepared (not yet approved).");
      const a = await tx.payrollAdjustment.create({ data: { slipId: slip.id, kind: input.kind, amount: input.amount, note: input.note, createdById: ctx.userId }, select: { id: true } });
      await audit(tx, actorOf(ctx), { action: "payroll_adjustment.add", entityType: "PayrollSlip", entityId: slip.id, after: { adjustmentId: a.id, kind: input.kind } });
      return a;
    });
  } catch (e) {
    return busy(e);
  }
}

export async function removeAdjustment(ctx: AuthContext, id: string) {
  authorize(ctx, "payroll.prepare");
  assertActorLinked(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockPayroll(tx);
      const adj = await tx.payrollAdjustment.findUnique({ where: { id }, select: { slipId: true, kind: true } });
      if (!adj) throw new NotFoundError("Adjustment not found.");
      const { run, slip } = await lockSlip(tx, adj.slipId);
      if (isOwnRecord(ctx, slip.employee_id)) throw new ForbiddenError("You can't adjust your own salary slip.");
      if (run.status !== "PREPARED") throw new ConflictError("Adjustments can only be removed while the payroll is prepared (not yet approved).");
      await tx.payrollAdjustment.delete({ where: { id } });
      await audit(tx, actorOf(ctx), { action: "payroll_adjustment.remove", entityType: "PayrollSlip", entityId: slip.id, before: { adjustmentId: id, kind: adj.kind } });
    });
  } catch (e) {
    busy(e);
  }
}

// ───────────────────────────── Payments (P13) ─────────────────────────────

async function paidSoFar(tx: Tx, slipId: string) {
  const agg = await tx.salaryPayment.aggregate({ where: { slipId }, _sum: { amount: true } });
  return new Decimal(agg._sum.amount?.toString() ?? "0");
}

async function markPaidIfComplete(tx: Tx, runId: string) {
  const unpaid = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM payroll_slip s
    WHERE s.run_id = ${runId} AND s.net > COALESCE((SELECT sum(p.amount) FROM salary_payment p WHERE p.slip_id = s.id), 0)`;
  if (Number(unpaid[0]?.n ?? 0) === 0) {
    await tx.payrollRun.updateMany({ where: { id: runId, status: "APPROVED" }, data: { status: "PAID", version: { increment: 1 } } });
    return true;
  }
  return false;
}

async function assertPaidOnOk(tx: Tx, paidOn: string) {
  const { timezone } = await readPayrollSettingsTx(tx);
  if (paidOn > todayInTimeZone(timezone ?? undefined)) throw new ValidationError("The payment date can't be in the future.", [{ path: "paidOn", message: "In the future." }]);
}

export async function recordPayment(ctx: AuthContext, input: RecordPaymentInput) {
  authorize(ctx, "payroll.pay");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPayroll(tx);
      const { run, slip } = await lockSlip(tx, input.slipId);
      if (isOwnRecord(ctx, slip.employee_id)) throw new ForbiddenError("You can't record a payment of your own salary. Someone else must do it.");
      if (run.status !== "APPROVED" && run.status !== "PAID") throw new ConflictError("Payments can only be recorded for an approved payroll.");
      await assertPaidOnOk(tx, input.paidOn);
      const due = new Decimal(slip.net).minus(await paidSoFar(tx, slip.id));
      if (new Decimal(input.amount).gt(due)) throw new ValidationError(`Only ₹${due.toFixed(2)} is still due on this slip.`, [{ path: "amount", message: "More than the amount due." }]);
      const p = await tx.salaryPayment.create({
        data: { slipId: slip.id, amount: input.amount, method: input.method, reference: input.reference, paidOn: new Date(`${input.paidOn}T00:00:00.000Z`), paidById: ctx.userId },
        select: { id: true },
      });
      const fullyPaid = await markPaidIfComplete(tx, run.id);
      // Method and date only — never the amount or the reference (bank details).
      await audit(tx, actorOf(ctx), { action: "salary_payment.record", entityType: "PayrollSlip", entityId: slip.id, after: { paymentId: p.id, method: input.method, paidOn: input.paidOn, runPaid: fullyPaid } });
      return { id: p.id, runPaid: fullyPaid };
    });
  } catch (e) {
    return busy(e);
  }
}

/** Record the full remaining balance of every slip in the run (except the actor's own) in one transaction. */
export async function recordBulkPayment(ctx: AuthContext, input: BulkPaymentInput) {
  authorize(ctx, "payroll.pay");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockPayroll(tx);
        const [run] = await tx.$queryRaw<{ status: string }[]>`SELECT status::text AS status FROM payroll_run WHERE id = ${input.runId} FOR UPDATE`;
        if (!run) throw new NotFoundError("Payroll run not found.");
        if (run.status !== "APPROVED") throw new ConflictError(run.status === "PAID" ? "This payroll is already fully paid." : "Payments can only be recorded for an approved payroll.");
        await assertPaidOnOk(tx, input.paidOn);
        const due = await tx.$queryRaw<{ id: string; employee_id: string; slip_no: string | null; due: string }[]>`
          SELECT s.id, s.employee_id, s.slip_no, (s.net - COALESCE((SELECT sum(p.amount) FROM salary_payment p WHERE p.slip_id = s.id), 0))::text AS due
          FROM payroll_slip s WHERE s.run_id = ${input.runId} ORDER BY s.id FOR UPDATE OF s`;
        const own = due.filter((d) => isOwnRecord(ctx, d.employee_id) && new Decimal(d.due).gt(0));
        const payable = due.filter((d) => !isOwnRecord(ctx, d.employee_id) && new Decimal(d.due).gt(0));
        if (payable.length === 0) throw new ConflictError(own.length ? "Only your own slip is unpaid; someone else must record it." : "Nothing is due.");
        await tx.salaryPayment.createMany({
          data: payable.map((d) => ({
            slipId: d.id,
            amount: d.due,
            method: input.method,
            reference: input.reference === null ? null : `${input.reference}/${d.slip_no ?? d.id}`.slice(0, 64),
            paidOn: new Date(`${input.paidOn}T00:00:00.000Z`),
            paidById: ctx.userId,
          })),
        });
        const fullyPaid = await markPaidIfComplete(tx, input.runId);
        await audit(tx, actorOf(ctx), { action: "salary_payment.bulk", entityType: "PayrollRun", entityId: input.runId, after: { slips: payable.length, method: input.method, paidOn: input.paidOn, runPaid: fullyPaid, ownSlipLeft: own.length > 0 } });
        return { slips: payable.length, runPaid: fullyPaid, ownSlipLeft: own.length > 0 };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Reads ─────────────────────────────

const SLIP_DETAIL = {
  id: true,
  slipNo: true,
  salarySnapshot: true,
  dayBasis: true,
  monthDays: true,
  offRollsDays: true,
  lopDays: true,
  paidDays: true,
  earnings: true,
  deductions: true,
  gross: true,
  totalDeductions: true,
  net: true,
  run: { select: { id: true, month: true, status: true } },
  employee: { select: { id: true, employeeCode: true, fullName: true, designation: { select: { name: true } }, department: { select: { name: true } } } },
  adjustments: { orderBy: { createdAt: "asc" as const }, select: { id: true, kind: true, amount: true, note: true } },
  payments: { orderBy: { paidOn: "asc" as const }, select: { id: true, amount: true, method: true, reference: true, paidOn: true } },
} as const;

/** One slip: payroll readers any slip; staff their own approved / paid slip (salary.self.read SELF). Others: NotFound. */
export async function getSlip(ctx: AuthContext, slipId: string) {
  const reader = hasPermission(ctx, "payroll.read");
  const self = hasPermission(ctx, "salary.self.read") && scopeFor(ctx, "salary.self.read") === "SELF";
  if (!reader && !self) authorize(ctx, "payroll.read"); // throws Forbidden
  const slip = await prisma.payrollSlip.findUnique({ where: { id: slipId }, select: SLIP_DETAIL });
  if (!slip) throw new NotFoundError("Salary slip not found.");
  const own = isOwnRecord(ctx, slip.employee.id);
  if (!reader && !(own && (slip.run.status === "APPROVED" || slip.run.status === "PAID"))) throw new NotFoundError("Salary slip not found.");
  return { ...slip, own };
}

/** "My salary slips" (P12): the caller's own slips of approved / paid runs. */
export async function listMySlips(ctx: AuthContext) {
  authorize(ctx, "salary.self.read");
  if (typeof ctx.employeeId !== "string" || ctx.employeeId === "") return { linked: false as const };
  const slips = await prisma.payrollSlip.findMany({
    where: { employeeId: ctx.employeeId, run: { status: { in: ["APPROVED", "PAID"] } } },
    orderBy: { run: { month: "desc" } },
    take: 120,
    select: { id: true, slipNo: true, net: true, run: { select: { month: true, status: true } } },
  });
  return { linked: true as const, slips };
}
