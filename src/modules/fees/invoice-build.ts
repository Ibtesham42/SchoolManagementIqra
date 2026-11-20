import { MONEY_MAX, sumMoney, toMoney } from "@/lib/money";
import { priceLines, type ConcessionInput } from "./fee-calc";
import { itemApplies, type AppliesTo, type InvoiceItemKindLite } from "./fee-rules";

/**
 * Pure invoice building for one student and one installment (PHASE_5_PLAN.md FC4–FC6, FC18). No I/O — unit tested.
 * - STRUCTURE lines: the class structure's amounts for the installment whose fee head applies to the student
 *   (ALL / NEW_ADMISSION / EXISTING); zero amounts are left out.
 * - CHARGE lines: the student's unbilled manual / transport charges for the installment.
 * - Concessions (approved, of this session) apply to STRUCTURE lines only — never to extra charges or late fees.
 * - Status: WAIVED when concessions bring the total to 0, otherwise ISSUED. Nothing to bill → null (no invoice).
 */
export interface StructureLine {
  structureItemId: string;
  categoryId: string;
  categoryName: string;
  appliesTo: AppliesTo;
  amount: string;
}
export interface ChargeLine {
  chargeId: string;
  categoryId: string;
  categoryName: string;
  amount: string;
}
export interface BuiltItem {
  kind: InvoiceItemKindLite;
  categoryId: string;
  description: string;
  amount: string;
  concessionAmount: string;
  chargeId: string | null;
  sortOrder: number;
}
export interface BuiltInvoice {
  items: BuiltItem[];
  subtotal: string;
  concessionTotal: string;
  total: string;
  status: "ISSUED" | "WAIVED";
}

export function buildInvoice(structure: readonly StructureLine[], charges: readonly ChargeLine[], concessions: readonly ConcessionInput[], newAdmission: boolean): BuiltInvoice | null {
  const lines = structure.filter((l) => itemApplies(l.appliesTo, newAdmission) && toMoney(l.amount).gt(0));
  const priced = priceLines(
    lines.map((l) => ({ key: l.structureItemId, categoryId: l.categoryId, amount: l.amount })),
    concessions,
  );
  const items: BuiltItem[] = [
    ...lines.map((l, i) => ({ kind: "STRUCTURE" as const, categoryId: l.categoryId, description: l.categoryName, amount: priced[i].amount, concessionAmount: priced[i].concession, chargeId: null, sortOrder: i })),
    ...charges
      .filter((c) => toMoney(c.amount).gt(0))
      .map((c, i) => ({ kind: "CHARGE" as const, categoryId: c.categoryId, description: c.categoryName, amount: toMoney(c.amount).toFixed(2), concessionAmount: "0.00", chargeId: c.chargeId, sortOrder: lines.length + i })),
  ];
  if (items.length === 0) return null;
  const subtotal = sumMoney(items.map((i) => i.amount));
  const concessionTotal = sumMoney(items.map((i) => i.concessionAmount));
  const total = subtotal.minus(concessionTotal);
  if (subtotal.gt(MONEY_MAX)) throw new RangeError("invoice total out of range");
  return { items, subtotal: subtotal.toFixed(2), concessionTotal: concessionTotal.toFixed(2), total: total.toFixed(2), status: total.gt(0) ? "ISSUED" : "WAIVED" };
}

/**
 * Re-pricing an UNPAID invoice after a concession is approved or revoked (FC6): STRUCTURE items get the new concession
 * amounts; CHARGE and LATE_FEE items keep theirs. Returns the new per-item concession and the totals.
 */
export function repriceItems(items: readonly { id: string; kind: InvoiceItemKindLite; categoryId: string; amount: string; concessionAmount: string }[], concessions: readonly ConcessionInput[]) {
  const structure = items.filter((i) => i.kind === "STRUCTURE");
  const priced = new Map(priceLines(structure.map((i) => ({ key: i.id, categoryId: i.categoryId, amount: i.amount })), concessions).map((p) => [p.key, p.concession]));
  const next = items.map((i) => ({ id: i.id, concessionAmount: i.kind === "STRUCTURE" ? priced.get(i.id)! : toMoney(i.concessionAmount).toFixed(2) }));
  const lateFee = sumMoney(items.filter((i) => i.kind === "LATE_FEE").map((i) => i.amount));
  const subtotal = sumMoney(items.filter((i) => i.kind !== "LATE_FEE").map((i) => i.amount));
  const concessionTotal = sumMoney(next.map((n) => n.concessionAmount));
  const total = subtotal.minus(concessionTotal).plus(lateFee);
  return { items: next, subtotal: subtotal.toFixed(2), concessionTotal: concessionTotal.toFixed(2), lateFee: lateFee.toFixed(2), total: total.toFixed(2), status: total.gt(0) ? ("ISSUED" as const) : ("WAIVED" as const) };
}
