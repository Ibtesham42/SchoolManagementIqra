import Decimal from "decimal.js";

/**
 * Pure Phase 3C payroll calculation (no I/O — unit tested). PHASE_3C_PLAN.md P2, P3, P10, P14, P15; payroll-management
 * skill. decimal.js only (CLAUDE.md rule 7); every component rounded half-up to 2 dp, then summed.
 *
 * - Days: `monthDays` is the MONTH's working or calendar days (school setting, P3) — never the employee's own count
 *   (3B audit M5-M1). `paidDays = monthDays − offRollsDays − lopDays`.
 * - Basic (from the approved EmployeeSalary) is always the first earning and is always prorated.
 * - Each structure item: FIXED rupees, or PERCENT_OF_BASIC of the FULL basic; prorated items are multiplied by
 *   paidDays / monthDays. No statutory logic (P2): PF, ESI, professional tax are ordinary deduction items.
 * - Adjustments (P10): bonus / arrears / other earnings add to gross; other deductions add to deductions.
 * - Net is never negative: such a slip is refused (the preparer fixes the adjustment or the structure), never
 *   silently capped — there is no advance to cap in 3C (P9 deferred).
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;
const money = (d: Dec) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export type DayBasis = "WORKING_DAYS" | "CALENDAR_DAYS";
export type ComponentKind = "EARNING" | "DEDUCTION";
export type ComponentCalc = "FIXED" | "PERCENT_OF_BASIC";
export type AdjustmentKind = "BONUS" | "ARREARS" | "OTHER_EARNING" | "OTHER_DEDUCTION";

export interface SalaryItem {
  code: string;
  name: string;
  kind: ComponentKind;
  calc: ComponentCalc;
  /** Rupees (FIXED) or percent 0–100 (PERCENT_OF_BASIC), as a decimal string. */
  value: string;
  prorated: boolean;
}

export interface SlipInput {
  basic: string;
  items: readonly SalaryItem[];
  monthDays: number;
  offRollsDays: number;
  /** Decimal string in half days, e.g. "2.5". */
  lopDays: string;
  adjustments: readonly { kind: AdjustmentKind; amount: string }[];
}

export interface SlipLine {
  code: string;
  name: string;
  amount: string;
}

export interface SlipResult {
  monthDays: number;
  offRollsDays: number;
  lopDays: string;
  paidDays: string;
  earnings: SlipLine[];
  deductions: SlipLine[];
  /** Components + earning adjustments. */
  gross: string;
  /** Components + deduction adjustments. */
  totalDeductions: string;
  net: string;
}

export class PayrollCalcError extends Error {
  constructor(
    readonly code: "NO_DAYS" | "DAYS_OUT_OF_RANGE" | "BAD_AMOUNT" | "BAD_PERCENT" | "NEGATIVE_NET",
    message: string,
  ) {
    super(message);
    this.name = "PayrollCalcError";
  }
}

const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
const HALF_DAYS_RE = /^\d{1,2}(\.[05])?$/;

function amount(raw: string, what: string): Dec {
  if (!AMOUNT_RE.test(raw)) throw new PayrollCalcError("BAD_AMOUNT", `${what} must be a non-negative amount with at most 2 decimals.`);
  return new D(raw);
}

export const EARNING_ADJUSTMENTS: ReadonlySet<AdjustmentKind> = new Set(["BONUS", "ARREARS", "OTHER_EARNING"]);

export function calculateSlip(input: SlipInput): SlipResult {
  const { monthDays, offRollsDays } = input;
  if (!Number.isInteger(monthDays) || monthDays < 1 || monthDays > 31) {
    throw new PayrollCalcError("NO_DAYS", "The month has no payable days on this basis.");
  }
  if (!HALF_DAYS_RE.test(input.lopDays)) throw new PayrollCalcError("DAYS_OUT_OF_RANGE", "LOP days must be whole or half days.");
  const lop = new D(input.lopDays);
  if (!Number.isInteger(offRollsDays) || offRollsDays < 0 || lop.plus(offRollsDays).gt(monthDays)) {
    throw new PayrollCalcError("DAYS_OUT_OF_RANGE", "LOP and days not on the rolls can't exceed the month's days.");
  }
  const paidDays = new D(monthDays).minus(offRollsDays).minus(lop);
  const factor = paidDays.div(monthDays);
  const basic = amount(input.basic, "Basic");

  const earnings: SlipLine[] = [{ code: "BASIC", name: "Basic", amount: money(basic.times(factor)).toFixed(2) }];
  const deductions: SlipLine[] = [];
  for (const item of input.items) {
    const value = amount(item.value, item.name);
    if (item.calc === "PERCENT_OF_BASIC" && value.gt(100)) {
      throw new PayrollCalcError("BAD_PERCENT", `${item.name}: a percentage of basic can't exceed 100.`);
    }
    const full = item.calc === "FIXED" ? value : basic.times(value).div(100);
    const line = { code: item.code, name: item.name, amount: money(item.prorated ? full.times(factor) : full).toFixed(2) };
    (item.kind === "EARNING" ? earnings : deductions).push(line);
  }

  const sum = (lines: SlipLine[]) => lines.reduce((t, l) => t.plus(l.amount), new D(0));
  let gross = sum(earnings);
  let totalDeductions = sum(deductions);
  for (const adj of input.adjustments) {
    const a = amount(adj.amount, "Adjustment");
    if (a.lte(0)) throw new PayrollCalcError("BAD_AMOUNT", "An adjustment must be more than zero.");
    if (EARNING_ADJUSTMENTS.has(adj.kind)) gross = gross.plus(a);
    else totalDeductions = totalDeductions.plus(a);
  }
  const net = gross.minus(totalDeductions);
  if (net.isNegative()) {
    throw new PayrollCalcError(
      "NEGATIVE_NET",
      `Deductions (${totalDeductions.toFixed(2)}) are more than the gross pay (${gross.toFixed(2)}). Reduce a deduction or an adjustment.`,
    );
  }
  return {
    monthDays,
    offRollsDays,
    lopDays: lop.toString(),
    paidDays: paidDays.toString(),
    earnings,
    deductions,
    gross: gross.toFixed(2),
    totalDeductions: totalDeductions.toFixed(2),
    net: net.toFixed(2),
  };
}

// ───────────────────────────── Day counts by basis (P3, P15) ─────────────────────────────

/**
 * The slip's day counts from the month's calendar and the 3B-M5 attendance summary. WORKING_DAYS: the month's working
 * days and the working days off the rolls. CALENDAR_DAYS: every calendar day, and every calendar day off the rolls.
 * LOP is the same on both bases (LOP only arises on working days).
 */
export function slipDays(
  basis: DayBasis,
  days: readonly { date: string; kind: "working" | "weekly_off" | "holiday" }[],
  onRolls: (iso: string) => boolean,
  lopDays: string,
): { monthDays: number; offRollsDays: number; lopDays: string } {
  const counted = basis === "WORKING_DAYS" ? days.filter((d) => d.kind === "working") : days;
  return {
    monthDays: counted.length,
    offRollsDays: counted.filter((d) => !onRolls(d.date)).length,
    lopDays,
  };
}
