import Decimal from "decimal.js";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { formatSequence, nextSequenceBlock, sequenceKey, validateFormat } from "@/lib/sequence";
import { todayInTimeZone } from "@/lib/format";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import type { Prisma } from "@/generated/prisma/client";
import { assertActorLinked } from "@/modules/hr/hr.policy";
import { lockLeaveCalendar } from "@/modules/hr/leave.tx";
import { lockAttendanceMonthTx, payrollMonthInputsTx, unlockAttendanceMonthTx } from "@/modules/hr/payroll-inputs.tx";
import { readPayrollSettingsTx } from "@/modules/settings/settings.service";
import { calculateSlip, PayrollCalcError, slipDays, type AdjustmentKind, type SalaryItem } from "./payroll-calc";
import { lockPayroll } from "./payroll.tx";
import type { CreateRunInput, ReopenRunInput, RunRefInput } from "./runs.schemas";

/**
 * Phase 3C-M3 / M4 — payroll runs: create, prepare, approve, reopen (PHASE_3C_PLAN.md P3–P6, P10, P11, P15, P16, ADR-037).
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
/** P11: slip numbers. Default until the school sets idFormats.salarySlip (validated; same tokens as other IDs). */
export const DEFAULT_SLIP_FORMAT = "SLIP-{YYYY}-{SEQ:5}";
const SLIP_SEQUENCE = "salary_slip";
async function readSlipFormatTx(tx: Tx) {
  const row = await tx.schoolSetting.findFirst({ select: { idFormats: true, shortCode: true } });
  const formats = row?.idFormats && typeof row.idFormats === "object" && !Array.isArray(row.idFormats) ? (row.idFormats as Record<string, unknown>) : {};
  const configured = typeof formats.salarySlip === "string" ? formats.salarySlip : null;
  const slipFormat = configured && validateFormat(configured) === null ? configured : DEFAULT_SLIP_FORMAT;
  return { slipFormat, shortCode: row?.shortCode ?? null };
}
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
  // Review 3C-M4 L4: exactly one row per employee (DISTINCT ON), never a total-row cap that could drop staff.
  if (employeeIds.length === 0) return new Map();
  const latest = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ON (employee_id) id FROM employee_salary
    WHERE employee_id = ANY(${employeeIds}) AND status = 'APPROVED' AND effective_from <= ${month}
    ORDER BY employee_id, effective_from DESC`;
  const rows = await tx.employeeSalary.findMany({
    where: { id: { in: latest.map((l) => l.id) } },
    orderBy: [{ employeeId: "asc" }],
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

/** One computed slip (prepare writes it; approve compares it with what is stored — KI-081 item 2). */
interface ComputedSlip {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  data: {
    employeeSalaryId: string;
    salarySnapshot: Prisma.InputJsonValue;
    dayBasis: "WORKING_DAYS" | "CALENDAR_DAYS";
    monthDays: number;
    offRollsDays: number;
    lopDays: string;
    paidDays: string;
    earnings: Prisma.InputJsonValue;
    deductions: Prisma.InputJsonValue;
    gross: string;
    totalDeductions: string;
    net: string;
  };
}

/**
 * The month's slips as they would be computed NOW (caller holds the payroll and leave-calendar locks). Refuses an
 * unfinished month, an unset basis, incomplete attendance (P4) and invalid slips (named).
 */
async function computeSlipsTx(tx: Tx, runId: string, monthStart: Date) {
  const month = ymOf(monthStart);
  const { dayBasis, timezone } = await readPayrollSettingsTx(tx);
  if (!dayBasis) throw new ConflictError("Choose how pay is prorated (working days or calendar days) in Settings first.");
  const today = todayInTimeZone(timezone ?? undefined);
  const { days, employees } = await payrollMonthInputsTx(tx, month, today);
  if (days.length > 0 && days[days.length - 1].date >= today) throw new ConflictError(`${month} hasn't ended yet. Prepare payroll after its last day.`);
  const incomplete = employees.filter((e) => !e.summary.complete);
  if (incomplete.length > 0) {
    const names = incomplete.slice(0, 5).map((e) => `${e.fullName} (${e.employeeCode}, ${e.summary.unmarked} unmarked)`);
    throw new ConflictError(`Attendance for ${month} isn't complete for ${incomplete.length} staff: ${names.join("; ")}${incomplete.length > 5 ? "; …" : ""}. Mark it first.`);
  }
  const salaries = await salariesForMonth(tx, employees.map((e) => e.id), monthStart);
  const paid = employees.filter((e) => salaries.has(e.id));
  const withoutSalary = employees.filter((e) => !salaries.has(e.id));
  const adjustments = await tx.payrollAdjustment.findMany({ where: { slip: { runId } }, select: { kind: true, amount: true, slip: { select: { employeeId: true } } } });
  const adjBy = new Map<string, { kind: AdjustmentKind; amount: string }[]>();
  for (const a of adjustments) adjBy.set(a.slip.employeeId, [...(adjBy.get(a.slip.employeeId) ?? []), { kind: a.kind, amount: a.amount.toFixed(2) }]);
  const slips: ComputedSlip[] = [];
  for (const e of paid) {
    const sal = salaries.get(e.id)!;
    const items: SalaryItem[] = sal.structure.items.map((i) => ({ code: i.component.code, name: i.component.name, kind: i.component.kind, calc: i.component.calc, value: i.value.toFixed(2), prorated: i.component.prorated }));
    const d = slipDays(dayBasis, days, e.onRolls, e.summary.lopDays.toString());
    let slip;
    try {
      slip = calculateSlip({ basic: sal.basic.toFixed(2), items, monthDays: d.monthDays, offRollsDays: d.offRollsDays, lopDays: d.lopDays, adjustments: adjBy.get(e.id) ?? [] });
    } catch (err) {
      if (err instanceof PayrollCalcError) throw new ConflictError(`${e.fullName} (${e.employeeCode}): ${err.message}`);
      throw err;
    }
    slips.push({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      data: {
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
      },
    });
  }
  return { month, dayBasis, slips, withoutSalary, employeesWithAdjustments: new Set(adjBy.keys()) };
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
        const c = await computeSlipsTx(tx, run.id, run.month);
        if (c.slips.length === 0) throw new ConflictError("No one on the rolls has an approved salary for this month.");
        const existing = await tx.payrollSlip.findMany({ where: { runId: run.id }, select: { id: true, employeeId: true } });
        const existingBy = new Map(existing.map((s) => [s.employeeId, s.id]));
        const keep = new Set(c.slips.map((s) => s.employeeId));
        const dropped = existing.filter((s) => !keep.has(s.employeeId));
        if (dropped.some((s) => c.employeesWithAdjustments.has(s.employeeId))) {
          throw new ConflictError("A slip with adjustments would be dropped (the employee no longer qualifies). Remove its adjustments first.");
        }
        let gross = new Decimal(0);
        let deductions = new Decimal(0);
        const fresh = c.slips.filter((s) => !existingBy.has(s.employeeId));
        if (fresh.length > 0) await tx.payrollSlip.createMany({ data: fresh.map((s) => ({ ...s.data, runId: run.id, employeeId: s.employeeId })) });
        for (const s of c.slips) {
          const prior = existingBy.get(s.employeeId);
          if (prior) await tx.payrollSlip.update({ where: { id: prior }, data: { ...s.data, version: { increment: 1 } } });
          gross = gross.plus(s.data.gross);
          deductions = deductions.plus(s.data.totalDeductions);
        }
        if (dropped.length > 0) await tx.payrollSlip.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });
        const r = await tx.payrollRun.updateMany({
          where: { id: run.id, version: run.version },
          data: {
            status: "PREPARED",
            dayBasis: c.dayBasis,
            employeeCount: c.slips.length,
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
          after: { month: c.month, dayBasis: c.dayBasis, slips: c.slips.length, droppedSlips: dropped.length, staffWithoutSalary: c.withoutSalary.length },
        });
        return { slips: c.slips.length, withoutSalary: c.withoutSalary.map((e) => ({ employeeCode: e.employeeCode, fullName: e.fullName })) };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    return busy(e);
  }
}

// ───────────────────────────── 3C-M4: approve / reopen ─────────────────────────────

const SAME_FIELDS = ["employeeSalaryId", "dayBasis", "monthDays", "offRollsDays", "lopDays", "paidDays", "gross", "totalDeductions", "net"] as const;

/**
 * Approve (P5, P6, P11; R4; KI-081 item 2): `payroll.approve`, linked actor, not the preparer, and no slip of the
 * approver's own in the run (Super Admin included). The slips are recomputed under the locks and must equal the stored
 * ones — any attendance correction, new salary or setting change since preparing refuses ("prepare again"). Then slip
 * numbers (lib/sequence, kept on reopen) and the attendance-month lock (P5), in one transaction.
 */
export async function approveRun(ctx: AuthContext, input: RunRefInput) {
  authorize(ctx, "payroll.approve");
  assertActorLinked(ctx);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockPayroll(tx);
        await lockLeaveCalendar(tx);
        const [run] = await tx.$queryRaw<{ id: string; month: Date; status: string; version: number; prepared_by_id: string | null }[]>`
          SELECT id, month, status::text AS status, version, prepared_by_id FROM payroll_run WHERE id = ${input.id} FOR UPDATE`;
        if (!run) throw new NotFoundError("Payroll run not found.");
        if (run.version !== input.version) throw stale();
        if (run.status !== "PREPARED") throw new ConflictError(run.status === "DRAFT" ? "Prepare the payroll before approving it." : "This payroll is already approved.");
        if (run.prepared_by_id === ctx.userId) throw new ForbiddenError("You prepared this payroll, so someone else must approve it.");
        const stored = await tx.payrollSlip.findMany({
          where: { runId: run.id },
          select: { id: true, employeeId: true, slipNo: true, employeeSalaryId: true, dayBasis: true, monthDays: true, offRollsDays: true, lopDays: true, paidDays: true, gross: true, totalDeductions: true, net: true },
        });
        if (typeof ctx.employeeId === "string" && stored.some((s) => s.employeeId === ctx.employeeId)) {
          throw new ForbiddenError("Your own slip is in this payroll, so another approver must approve it.");
        }
        const c = await computeSlipsTx(tx, run.id, run.month);
        // Compare numbers as numbers (stored Decimal "1.0" equals computed "1"), ids and enums as text.
        const NUMERIC = new Set<string>(["monthDays", "offRollsDays", "lopDays", "paidDays", "gross", "totalDeductions", "net"]);
        const norm = (f: string, v: unknown) => (NUMERIC.has(f) ? new Decimal(String(v)).toFixed(2) : String(v));
        const storedBy = new Map(stored.map((s) => [s.employeeId, s]));
        const changed =
          c.slips.length !== stored.length ||
          c.slips.some((s) => {
            const cur = storedBy.get(s.employeeId);
            return !cur || SAME_FIELDS.some((f) => norm(f, cur[f]) !== norm(f, s.data[f]));
          });
        if (changed) throw new ConflictError("Attendance, salaries or settings changed since this payroll was prepared. Ask the preparer to prepare it again.");

        const { slipFormat, shortCode } = await readSlipFormatTx(tx);
        const year = run.month.getUTCFullYear();
        const tokens = { year, code: shortCode ?? undefined };
        // Review 3C-M4 (Medium): one block of numbers and one UPDATE, not two round trips per slip.
        const toNumber = stored.filter((x) => x.slipNo === null).sort((a, b) => a.id.localeCompare(b.id));
        if (toNumber.length > 0) {
          const first = await nextSequenceBlock(tx, sequenceKey(SLIP_SEQUENCE, slipFormat, tokens), toNumber.length);
          const ids = toNumber.map((s) => s.id);
          const numbers = toNumber.map((_, i) => formatSequence(slipFormat, first + i, tokens));
          await tx.$executeRaw`
            UPDATE payroll_slip AS p SET slip_no = v.no
            FROM unnest(${ids}::text[], ${numbers}::text[]) AS v(id, no)
            WHERE p.id = v.id AND p.slip_no IS NULL`;
        }
        await lockAttendanceMonthTx(tx, ymOf(run.month), ctx.userId);
        const r = await tx.payrollRun.updateMany({
          where: { id: run.id, version: run.version },
          data: { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date(), version: { increment: 1 } },
        });
        if (r.count !== 1) throw stale();
        await audit(tx, actorOf(ctx), { action: "payroll_run.approve", entityType: "PayrollRun", entityId: run.id, before: { status: "PREPARED" }, after: { status: "APPROVED", month: ymOf(run.month), slips: stored.length, attendanceLocked: true } });
        return { slips: stored.length };
      },
      { timeout: 30_000 },
    );
  } catch (e) {
    return busy(e);
  }
}

/** Reopen (P16): `payroll.approve`, with a reason, before any payment is recorded. Slip numbers are kept; the month unlocks. */
export async function reopenRun(ctx: AuthContext, input: ReopenRunInput) {
  authorize(ctx, "payroll.approve");
  assertActorLinked(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await lockPayroll(tx);
      await lockLeaveCalendar(tx);
      const [run] = await tx.$queryRaw<{ id: string; month: Date; status: string; version: number }[]>`
        SELECT id, month, status::text AS status, version FROM payroll_run WHERE id = ${input.id} FOR UPDATE`;
      if (!run) throw new NotFoundError("Payroll run not found.");
      if (run.version !== input.version) throw stale();
      if (run.status !== "APPROVED") throw new ConflictError(run.status === "PAID" ? "This payroll has payments; correct it in a later month (arrears or deductions)." : "Only an approved payroll can be reopened.");
      if ((await tx.salaryPayment.count({ where: { slip: { runId: run.id } } })) > 0) {
        throw new ConflictError("Payments are already recorded for this payroll; correct it in a later month (arrears or deductions).");
      }
      await unlockAttendanceMonthTx(tx, ymOf(run.month));
      const r = await tx.payrollRun.updateMany({
        where: { id: run.id, version: run.version },
        data: { status: "PREPARED", approvedById: null, approvedAt: null, reopenCount: { increment: 1 }, version: { increment: 1 } },
      });
      if (r.count !== 1) throw stale();
      await audit(tx, actorOf(ctx), { action: "payroll_run.reopen", entityType: "PayrollRun", entityId: run.id, before: { status: "APPROVED" }, after: { status: "PREPARED", month: ymOf(run.month), reasonGiven: input.reason.length > 0, attendanceLocked: false } });
    });
  } catch (e) {
    busy(e);
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
      preparedBy: { select: { id: true, displayName: true } },
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
