import { Money, MONEY_MAX, round2, sumMoney, toMoney, toRate, type MoneyValue } from "@/lib/money";

/**
 * Pure Phase 5 fee calculation (PHASE_5_PLAN.md FC6, FC7, FC24; fee-management skill). No I/O — unit tested.
 *
 * Concessions on an invoice's lines:
 *  - PERCENT concessions first: the percents that apply to a line's category are added (capped at 100 %) and taken
 *    off the line's ORIGINAL amount, rounded half-up per line;
 *  - then FIXED concessions, in the given order: each is a rupee amount PER INVOICE, i.e. per installment. With 12
 *    monthly installments a FIXED 500 is worth 6,000 a year, so the propose / approve screens must show that session
 *    total (review 5A M3). It is spread over its matching lines in line order, each line only down to zero (a FIXED
 *    value larger than what's left is partly unused — never negative, never moved to other categories);
 *  - a line's concession is between 0 and its amount; concession values must be above zero (review 5A L4).
 * Totals are sums of the rounded lines: total = subtotal − concessionTotal + lateFee. `lines` are the STRUCTURE /
 * CHARGE / OPENING_BALANCE items only; `lateFee` is the sum of the invoice's LATE_FEE items (review 5A I5: a frozen
 * late fee is never also a line, so it can't count twice). Concessions never apply to late fees.
 */
export type ConcessionCalc = "PERCENT" | "FIXED";
export type LateFeeCalc = "FLAT" | "PER_DAY" | "PERCENT";

export interface FeeLine {
  key: string;
  categoryId: string;
  /** Rupees, canonical decimal string (at most 2 decimals). */
  amount: string;
}

export interface ConcessionInput {
  id: string;
  calc: ConcessionCalc;
  /** Percent 0–100 (PERCENT) or rupees per invoice (FIXED), decimal string. */
  value: string;
  /** Categories the concession applies to (empty → none). */
  categoryIds: readonly string[];
}

export interface PricedLine extends FeeLine {
  concession: string;
  net: string;
}

export interface InvoiceTotals {
  lines: PricedLine[];
  subtotal: string;
  concessionTotal: string;
  lateFee: string;
  total: string;
}

const s2 = (d: MoneyValue) => d.toFixed(2);
const valueOf = (c: ConcessionInput) => (c.calc === "PERCENT" ? toRate(c.value) : toMoney(c.value));

export function priceLines(lines: readonly FeeLine[], concessions: readonly ConcessionInput[]): PricedLine[] {
  for (const c of concessions) if (valueOf(c).lte(0)) throw new RangeError("concession values must be above zero");
  const conc = new Map<string, MoneyValue>(lines.map((l) => [l.key, new Money(0)]));
  const amount = (l: FeeLine) => toMoney(l.amount);
  for (const l of lines) {
    if (amount(l).isNeg()) throw new RangeError("negative line amount");
    const pct = sumMoney(concessions.filter((c) => c.calc === "PERCENT" && c.categoryIds.includes(l.categoryId)).map(valueOf));
    const capped = Money.min(pct, 100);
    conc.set(l.key, Money.max(0, Money.min(round2(amount(l).times(capped).div(100)), amount(l))));
  }
  for (const c of concessions.filter((x) => x.calc === "FIXED")) {
    let left = valueOf(c);
    for (const l of lines) {
      if (left.lte(0)) break;
      if (!c.categoryIds.includes(l.categoryId)) continue;
      const room = amount(l).minus(conc.get(l.key)!);
      const take = Money.min(room, left);
      if (take.gt(0)) {
        conc.set(l.key, conc.get(l.key)!.plus(take));
        left = left.minus(take);
      }
    }
  }
  return lines.map((l) => {
    const c = conc.get(l.key)!;
    return { ...l, amount: s2(amount(l)), concession: s2(c), net: s2(amount(l).minus(c)) };
  });
}

export function invoiceTotals(lines: readonly FeeLine[], concessions: readonly ConcessionInput[], lateFee = "0"): InvoiceTotals {
  const priced = priceLines(lines, concessions);
  const subtotal = sumMoney(priced.map((l) => l.amount));
  const concessionTotal = sumMoney(priced.map((l) => l.concession));
  const late = toMoney(lateFee);
  if (late.isNeg()) throw new RangeError("negative late fee");
  const total = subtotal.minus(concessionTotal).plus(late);
  if (total.gt(MONEY_MAX)) throw new RangeError("invoice total out of range");
  return { lines: priced, subtotal: s2(subtotal), concessionTotal: s2(concessionTotal), lateFee: s2(late), total: s2(total) };
}

export interface LateFeeRule {
  graceDays: number;
  calc: LateFeeCalc;
  /** Rupees (FLAT, PER_DAY) or percent of the balance (PERCENT). */
  value: string;
  /** Maximum, rupees — required for PER_DAY (also a database CHECK). */
  cap: string | null;
}

/** Review 5A L2: a real calendar date only ("2026-02-31" and "2026-13-01" are refused, never rolled over). */
function dayNumber(iso: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RangeError("date expected");
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== iso) throw new RangeError("not a calendar date");
  return Math.round(ms / 86_400_000);
}

/** Days late as of a school-local date: 0 until the due date + grace days have passed. */
export function daysLate(dueOn: string, asOf: string, graceDays: number): number {
  if (!Number.isInteger(graceDays) || graceDays < 0) throw new RangeError("grace days must be a whole number ≥ 0");
  return Math.max(0, dayNumber(asOf) - dayNumber(dueOn) - graceDays);
}

/**
 * Late fee for one invoice as of `asOf` (school-local YYYY-MM-DD), on its unpaid balance. FC7: computed live, frozen
 * onto the invoice only when a payment is collected. FLAT once; PER_DAY × days late (cap required, review 5A L3);
 * PERCENT of the balance; capped; always within Decimal(12,2).
 */
export function lateFeeFor(rule: LateFeeRule | null, dueOn: string, asOf: string, balance: string): string {
  const bal = toMoney(balance);
  if (!rule || bal.lte(0)) return "0.00";
  const late = daysLate(dueOn, asOf, rule.graceDays);
  if (late === 0) return "0.00";
  const v = rule.calc === "PERCENT" ? toRate(rule.value) : toMoney(rule.value);
  if (v.lte(0)) throw new RangeError("late fee value must be above zero");
  if (rule.calc === "PER_DAY" && rule.cap === null) throw new RangeError("a per-day late fee needs a cap");
  let fee = rule.calc === "FLAT" ? v : rule.calc === "PER_DAY" ? v.times(late) : bal.times(v).div(100);
  if (rule.cap !== null) fee = Money.min(fee, toMoney(rule.cap));
  const out = round2(fee);
  if (out.gt(MONEY_MAX)) throw new RangeError("late fee out of range");
  return s2(out);
}
