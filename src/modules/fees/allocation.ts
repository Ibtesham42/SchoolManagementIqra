import { Money, sumMoney, toMoney, type MoneyValue } from "@/lib/money";

/**
 * Pure payment allocation (PHASE_5_PLAN.md FC8, FC9). No I/O — unit tested.
 * - Oldest due first (due date, then invoice number / id); the collector may limit it to chosen invoices.
 * - Within an invoice: items in their order, LATE_FEE items last.
 * - Exact paise: each allocation is at most the item's outstanding amount; the sum equals the payment.
 * - Over-payment is refused (no advance / credit balance in Phase 5); zero or negative amounts are refused.
 */
export type InvoiceItemKind = "STRUCTURE" | "CHARGE" | "LATE_FEE" | "OPENING_BALANCE";

export interface OpenItem {
  id: string;
  kind: InvoiceItemKind;
  sortOrder: number;
  /** amount − concession − paid, rupees. */
  outstanding: string;
}

export interface OpenInvoice {
  id: string;
  invoiceNo: string;
  dueOn: string;
  items: readonly OpenItem[];
}

export interface Allocation {
  invoiceId: string;
  itemId: string;
  amount: string;
}

export class AllocationError extends Error {
  constructor(
    readonly reason: "NOT_POSITIVE" | "OVERPAYMENT" | "NOTHING_DUE" | "UNKNOWN_INVOICE",
    message: string,
  ) {
    super(message);
  }
}

export function outstandingOf(invoices: readonly OpenInvoice[]): MoneyValue {
  return sumMoney(invoices.flatMap((i) => i.items.map((x) => toMoney(x.outstanding))));
}

/** Review 5A I6: plain code-unit comparison — the same order on every server, whatever its locale. */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

export function orderInvoices(invoices: readonly OpenInvoice[]): OpenInvoice[] {
  return [...invoices].sort((a, b) => cmp(a.dueOn, b.dueOn) || cmp(a.invoiceNo, b.invoiceNo) || cmp(a.id, b.id));
}

const orderItems = (items: readonly OpenItem[]) => [...items].sort((a, b) => Number(a.kind === "LATE_FEE") - Number(b.kind === "LATE_FEE") || a.sortOrder - b.sortOrder || cmp(a.id, b.id));

export function allocatePayment(amount: string, invoices: readonly OpenInvoice[], onlyInvoiceIds?: readonly string[]): Allocation[] {
  const pay = toMoney(amount);
  if (pay.lte(0)) throw new AllocationError("NOT_POSITIVE", "Enter an amount above zero.");
  let chosen = invoices;
  if (onlyInvoiceIds && onlyInvoiceIds.length > 0) {
    const known = new Set(invoices.map((i) => i.id));
    if (onlyInvoiceIds.some((id) => !known.has(id))) throw new AllocationError("UNKNOWN_INVOICE", "An invoice you chose is no longer open. Reload the page.");
    const pick = new Set(onlyInvoiceIds);
    chosen = invoices.filter((i) => pick.has(i.id));
  }
  const due = outstandingOf(chosen);
  if (due.lte(0)) throw new AllocationError("NOTHING_DUE", "Nothing is due on the chosen invoices.");
  if (pay.gt(due)) throw new AllocationError("OVERPAYMENT", `The amount is more than what is due (${due.toFixed(2)}).`);
  const out: Allocation[] = [];
  let left: MoneyValue = pay;
  for (const inv of orderInvoices(chosen)) {
    for (const item of orderItems(inv.items)) {
      if (left.lte(0)) return out;
      const o = toMoney(item.outstanding);
      if (o.lte(0)) continue;
      const take = Money.min(o, left);
      out.push({ invoiceId: inv.id, itemId: item.id, amount: take.toFixed(2) });
      left = left.minus(take);
    }
  }
  return out;
}
