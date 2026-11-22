import { moneyString, sumMoney, toMoney } from "@/lib/money";

/** Phase 5C-M1 pure report helpers (no I/O — unit tested). Money in and out as 2-decimal strings. */

export interface StudentInvoiceAgg {
  studentId: string;
  invoices: number;
  open: number;
  total: string;
  paid: string;
}

export interface RosterEntry {
  className: string;
  sectionCode: string;
  classLevel: number;
}

export interface ClassOutstandingRow {
  className: string;
  sectionCode: string;
  students: number;
  invoices: number;
  open: number;
  total: string;
  paid: string;
  balance: string;
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
export const REMOVED = "(removed student)";

/**
 * Outstanding by class and section: per-student invoice sums grouped by the student's section in the session.
 * Students no longer in the roster (removed records) are kept in one group so the totals still match the invoices.
 */
export function groupOutstandingByClass(perStudent: readonly StudentInvoiceAgg[], roster: ReadonlyMap<string, RosterEntry>): ClassOutstandingRow[] {
  const groups = new Map<string, { level: number; className: string; sectionCode: string; aggs: StudentInvoiceAgg[] }>();
  for (const a of perStudent) {
    const r = roster.get(a.studentId);
    const key = r ? `${r.className}\u0000${r.sectionCode}` : REMOVED;
    const g = groups.get(key) ?? { level: r ? r.classLevel : Number.MAX_SAFE_INTEGER, className: r ? r.className : REMOVED, sectionCode: r ? r.sectionCode : "", aggs: [] };
    g.aggs.push(a);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => a.level - b.level || cmp(a.className, b.className) || cmp(a.sectionCode, b.sectionCode))
    .map((g) => {
      const total = sumMoney(g.aggs.map((a) => a.total));
      const paid = sumMoney(g.aggs.map((a) => a.paid));
      return {
        className: g.className,
        sectionCode: g.sectionCode,
        students: g.aggs.length,
        invoices: g.aggs.reduce((s, a) => s + a.invoices, 0),
        open: g.aggs.reduce((s, a) => s + a.open, 0),
        total: moneyString(total),
        paid: moneyString(paid),
        balance: moneyString(total.minus(paid)),
      };
    });
}

/** Whole days from `fromIso` to `toIso` (school-local dates), never negative. */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.max(0, Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000));
}

/** The date `n` days before an ISO date. */
export function daysBefore(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
}

/** The waived amount of a late-fee waiver line ("Late fee ₹100.00 waived: …", KI-105). The reason is never returned. */
export function waiverAmount(description: string): string | null {
  const m = /^Late fee ₹(\d{1,10}(?:\.\d{1,2})?) waived:/.exec(description);
  return m ? moneyString(m[1]) : null;
}

/** "10%" or "Rs. 500.00 per installment" (FC6: a fixed concession applies to every installment). */
export function concessionValueText(calc: "PERCENT" | "FIXED", value: string): string {
  return calc === "PERCENT" ? `${toMoney(value).toString()}%` : `Rs. ${moneyString(value)} per installment`;
}

/** Sum of a money column. */
export const sumColumn = (values: readonly string[]): string => moneyString(sumMoney(values));

/** A run of missing numbers in one numbering series ("RCT/2026/" + 00042 … 00044). */
export interface NumberGap {
  prefix: string;
  from: number;
  to: number;
  /** Digits used by the series (zero padding), so the label prints numbers as they were issued. */
  width: number;
}

/** "RCT/2026/00042" or "RCT/2026/00042 – RCT/2026/00044 (3 missing)". */
export function gapLabel(g: NumberGap): string {
  const n = (k: number) => `${g.prefix}${String(k).padStart(g.width, "0")}`;
  return g.from === g.to ? n(g.from) : `${n(g.from)} – ${n(g.to)} (${g.to - g.from + 1} missing)`;
}
