import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { assertActorLinked } from "@/modules/hr/hr.policy";
import { lockLeaveCalendar } from "@/modules/hr/leave.tx";
import { payrollMonthInputsTx } from "@/modules/hr/payroll-inputs.tx";
import { readPayrollSettingsTx } from "@/modules/settings/settings.service";
import { calculateSlip, PayrollCalcError, slipDays, type SalaryItem } from "./payroll-calc";
import { lockPayroll } from "./payroll.tx";
import type { CreateRunInput, RunRefInput } from "./runs.schemas";

/**
 * Phase 3C-M3 — payroll runs: create and prepare (PHASE_3C_PLAN.md P3, P4, P10, P15, ADR-037).
 *
 * - `payroll.prepare` (Accountant, HR Manager); reads `payroll.read`. A non–Super Admin preparer must be linked.
 * - Prepare (and re-prepare, allowed until approval) computes one SNAPSHOT slip per employee on the rolls with an
 *   approved salary for the month: salary = latest APPROVED `effectiveFrom` ≤ the month; days from the 3B-M5 summary on
 *   the school's basis (P3, no default); `calculateSlip` (decimal, half-up, never negative). Existing adjustments are
 *   kept and re-applied.
 * - Refused when the month hasn't ended, the basis isn't set, any employee's attendance is incomplete (P4 — never
 *   guessed), or a slip would be invalid (named). Staff without an approved salary are listed, not paid.
 * - Locks: payroll (advisory) → leave calendar (advisory: attendance, leave, holidays and the weekly off can't change
 *   during the computation) → payroll_run (UPDATE). Audit rows carry counts only — never amounts.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const monthDate = (ym: string) => new Date(`${ym}-01T00:00:00.000Z`);
const ymOf = (d: Date) => d.toISOString().slice(0, 7);
/** Plain data (strings, numbers, booleans, arrays, objects) → Prisma JSON input. */
const json = (v: unknown) => v as Prisma.InputJsonValue;
const stale = () => new ConflictError("This payroll run was changed by someone else. Reload the page and try again.");

const busy = (e: unknown): never => {
  if (isUniqueViolation(e)) throw new ConflictError("A payroll run for this month already exists.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
};

// ───────────────────────────── Create ─────────────────────────────

export async function createRun(ctx: AuthContext, input: CreateRunInput) {
  authorize(ctx, "payroll.prepare");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(async (tx) => {
      await lockPayroll(tx);
      const { timezone } = await readPayrollSettingsTx(tx);
      if (input.month > todayInTimeZone(timezone ?? undefined).slice(0, 7)) {
        throw new ValidationError("Payroll can't be created for a future month.", [{ path: "month", message: "In the future." }]);
      }
      const run = await tx.payrollRun.create({ data: { month: monthDate(input.month) }, select: { id: true } });
      await audit(tx, actorOf(ctx), { action: "payroll_run.create", entityType: "PayrollRun", entityId: run.id, after: { month: input.month, status: "DRAFT" } });
      return run;
    });
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Prepare ─────────────────────────────

interface SalaryRow {
  id: string;
  employeeId: string;
  basic: Decimal;
  structure: { name: string; items: { value: Decimal; component: { code: string; name: string; kind: "EARNING" | "DEDUCTION"; calc: "FIXED" | "PERCENT_OF_BASIC"; prorated: boolean } }[] };
}

/** Latest APPROVED salary per employee effective on or before the month. */
async function salariesForMonth(tx: Tx, employeeIds: string[], month: Date): Promise<Map<string, SalaryRow>> {
  const rows = await tx.employeeSalary.findMany({
    where: { employeeId: { in: employeeIds }, status: "APPROVED", effectiveFrom: { lte: month } },
    orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }],
    take: employeeIds.length * 24,
    select: {
      id: true,
      employeeId: true,
      basic: true,
      effectiveFrom: true,
      structure: { select: { name: true, items: { orderBy: { sortOrder: "asc" }, select: { value: true, component: { select: { code: true, name: true, kind: true, calc: true, prorated: true } } } } } },
    },
  });
  const out = new Map<string, SalaryRow>();
  for (const r of rows) if (!out.has(r.employeeId)) out.set(r.employeeId, r);
  return out;
}

export async function prepareRun(ctx: AuthContext, input: RunRefInput) {
  authorize(ctx, "payroll.prepare");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockPayroll(tx);
        await lockLeaveCalendar(tx);
        const [run] = await tx.$queryRaw<{ id: string; month: Date; status: string; version: number }[]>`
          SELECT id, month, status::text AS status, version FROM payroll_run WHERE id = ${input.id} FOR UPDATE`;
        if (!run) throw new NotFoundError("Payroll run not found.");
        if (run.version !== input.version) throw stale();
        if (run.status !== "DRAFT" && run.status !== "PREPARED") throw new ConflictError("This payroll is already approved. Reopen it to prepare again.");
        const month = ymOf(run.month);
        const { dayBasis, timezone } = await readPayrollSettingsTx(tx);
        if (!dayBasis) throw new ConflictError("Choose how pay is prorated (working days or calendar days) in Settings first.");
        const today = todayInTimeZone(timezone ?? undefined);
        const { days, employees } = await payrollMonthInputsTx(tx, month, today);
        if (days.length > 0 && days[days.length - 1].date >= today) throw new ConflictError(`${month} hasn't ended yet. Prepare payroll after its last day.`);

        // P4: never guess attendance.
        const incomplete = employees.filter((e) => !e.summary.complete);
        if (incomplete.length > 0) {
          const names = incomplete.slice(0, 5).map((e) => `${e.fullName} (${e.employeeCode}, ${e.summary.unmarked} unmarked)`);
          throw new ConflictError(`Attendance for ${month} isn't complete for ${incomplete.length} staff: ${names.join("; ")}${incomplete.length > 5 ? "; …" : ""}. Mark it first.`);
        }

        const salaries = await salariesForMonth(tx, employees.map((e) => e.id), run.month);
        const paid = employees.filter((e) => salaries.has(e.id));
        const withoutSalary = employees.filter((e) => !salaries.has(e.id));
        if (paid.length === 0) throw new ConflictError("No one on the rolls has an approved salary for this month.");

        const existing = await tx.payrollSlip.findMany({
          where: { runId: run.id },
          select: { id: true, employeeId: true, adjustments: { select: { kind: true, amount: true } } },
        });
        const existingBy = new Map(existing.map((s) => [s.employeeId, s]));
        const paidIds = new Set(paid.map((e) => e.id));
        const dropped = existing.filter((s) => !paidIds.has(s.employeeId));
        if (dropped.some((s) => s.adjustments.length > 0)) {
          throw new ConflictError("A slip with adjustments would be dropped (the employee no longer qualifies). Remove its adjustments first.");
        }

        let gross = new Decimal(0);
        let deductions = new Decimal(0);
        for (const e of paid) {
          const sal = salaries.get(e.id)!;
          const items: SalaryItem[] = sal.structure.items.map((i) => ({ code: i.component.code, name: i.component.name, kind: i.component.kind, calc: i.component.calc, value: i.value.toFixed(2), prorated: i.component.prorated }));
          const d = slipDays(dayBasis, days, e.onRolls, e.summary.lopDays.toString());
          const prior = existingBy.get(e.id);
          let slip;
          try {
            slip = calculateSlip({
              basic: sal.basic.toFixed(2),
              items,
              monthDays: d.monthDays,
              offRollsDays: d.offRollsDays,
              lopDays: d.lopDays,
              adjustments: (prior?.adjustments ?? []).map((a) => ({ kind: a.kind, amount: a.amount.toFixed(2) })),
            });
          } catch (err) {
            if (err instanceof PayrollCalcError) throw new ConflictError(`${e.fullName} (${e.employeeCode}): ${err.message}`);
            throw err;
          }
          const data = {
            employeeSalaryId: sal.id,
            salarySnapshot: json({ structureName: sal.structure.name, basic: sal.basic.toFixed(2), items }),
            dayBasis,
            monthDays: slip.monthDays,
            offRollsDays: slip.offRollsDays,
            lopDays: slip.lopDays,
            paidDays: slip.paidDays,
            earnings: json(slip.earnings),
            deductions: json(slip.deductions),
            gross: slip.gross,
            totalDeductions: slip.totalDeductions,
            net: slip.net,
          };
          if (prior) await tx.payrollSlip.update({ where: { id: prior.id }, data: { ...data, version: { increment: 1 } } });
          else await tx.payrollSlip.create({ data: { ...data, runId: run.id, employeeId: e.id } });
          gross = gross.plus(slip.gross);
          deductions = deductions.plus(slip.totalDeductions);
        }
        if (dropped.length > 0) await tx.payrollSlip.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });

        const r = await tx.payrollRun.updateMany({
          where: { id: run.id, version: run.version },
          data: {
            status: "PREPARED",
            dayBasis,
            employeeCount: paid.length,
            totalGross: gross.toFixed(2),
            totalDeductions: deductions.toFixed(2),
            totalNet: gross.minus(deductions).toFixed(2),
            preparedById: ctx.userId,
            preparedAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (r.count !== 1) throw stale();
        await audit(tx, actorOf(ctx), {
          action: run.status === "DRAFT" ? "payroll_run.prepare" : "payroll_run.reprepare",
          entityType: "PayrollRun",
          entityId: run.id,
          after: { month, dayBasis, slips: paid.length, droppedSlips: dropped.length, staffWithoutSalary: withoutSalary.length },
        });
        return { slips: paid.length, withoutSalary: withoutSalary.map((e) => ({ employeeCode: e.employeeCode, fullName: e.fullName })) };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── Reads (payroll.read) ─────────────────────────────

export async function listRuns(ctx: AuthContext) {
  authorize(ctx, "payroll.read");
  return prisma.payrollRun.findMany({
    orderBy: { month: "desc" },
    take: 60,
    select: { id: true, month: true, status: true, employeeCount: true, totalNet: true, version: true, preparedAt: true, approvedAt: true },
  });
}

export async function getRun(ctx: AuthContext, id: string) {
  authorize(ctx, "payroll.read");
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    select: {
      id: true,
      month: true,
      status: true,
      dayBasis: true,
      employeeCount: true,
      totalGross: true,
      totalDeductions: true,
      totalNet: true,
      version: true,
      preparedAt: true,
      approvedAt: true,
      preparedBy: { select: { displayName: true } },
      approvedBy: { select: { displayName: true } },
      slips: {
        orderBy: [{ employee: { fullName: "asc" } }, { id: "asc" }],
        take: 2000,
        select: {
          id: true,
          slipNo: true,
          monthDays: true,
          offRollsDays: true,
          lopDays: true,
          paidDays: true,
          gross: true,
          totalDeductions: true,
          net: true,
          employee: { select: { id: true, employeeCode: true, fullName: true } },
          _count: { select: { adjustments: true } },
        },
      },
    },
  });
  if (!run) throw new NotFoundError("Payroll run not found.");
  return run;
}
