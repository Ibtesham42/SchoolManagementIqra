import type { prisma, Tx } from "@/lib/db";
import { moneyString } from "@/lib/money";
import { lateFeeFor, type LateFeeRule } from "./fee-calc";
import { lateFeeFrozen } from "./fee-rules";

/**
 * Read-only fee lookups shared by the counter (`collection.service`) and the parent portal (`fees.portal.ts`, Phase
 * 6B-M3), so both work out dues and the LIVE late fee the same way. NO AUTHORIZATION HERE: callers authorized first
 * (`fee.collect` at the counter; `assertPortalStudent` in the portal). Item `description` is returned raw — portal
 * callers must map it through their whitelist (KI-105: never the text of LATE_FEE lines).
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
type Db = Tx | typeof prisma;

/** Open invoices of a student (all sessions) with outstanding items and the live late fee as of `asOf`. */
export async function openInvoicesOf(db: Db, studentId: string, asOf: string, onlyIds?: string[]) {
  const invoices = await db.feeInvoice.findMany({
    where: { studentId, deletedAt: null, status: { in: ["ISSUED", "PARTIAL"] }, ...(onlyIds ? { id: { in: onlyIds } } : {}) },
    orderBy: [{ dueOn: "asc" }, { invoiceNo: "asc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      invoiceNo: true,
      academicSessionId: true,
      dueOn: true,
      total: true,
      paidAmount: true,
      enrollment: { select: { academicSession: { select: { name: true } } } },
      installment: { select: { name: true } },
      items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, kind: true, description: true, amount: true, concessionAmount: true, paidAmount: true, sortOrder: true, _count: { select: { allocations: true } } } },
    },
  });
  const rules = new Map<string, LateFeeRule | null>();
  for (const sid of new Set(invoices.map((i) => i.academicSessionId))) {
    const r = await db.lateFeeRule.findFirst({ where: { academicSessionId: sid, isActive: true }, select: { graceDays: true, calc: true, value: true, cap: true } });
    rules.set(sid, r ? { graceDays: r.graceDays, calc: r.calc, value: moneyString(r.value.toString()), cap: r.cap === null ? null : moneyString(r.cap.toString()) } : null);
  }
  return invoices.map((i) => {
    // A frozen late fee (amount > 0) or a waiver (zero, never allocated) stops the live late fee. A zero line WITH
    // allocation history was voided by a receipt cancellation (review 5B-M3 M1) and doesn't count.
    const hasLate = lateFeeFrozen(i.items.map((it) => ({ kind: it.kind, amount: it.amount.toString(), allocationCount: it._count.allocations })));
    const balance = i.total.minus(i.paidAmount);
    const liveLate = hasLate ? "0.00" : lateFeeFor(rules.get(i.academicSessionId) ?? null, iso(i.dueOn), asOf, moneyString(balance.toString()));
    return {
      id: i.id,
      invoiceNo: i.invoiceNo,
      sessionName: i.enrollment.academicSession.name,
      installmentName: i.installment?.name ?? "Previous dues",
      dueOn: iso(i.dueOn),
      balance: moneyString(balance.toString()),
      lateFee: liveLate,
      items: i.items.map((it) => ({ id: it.id, kind: it.kind, description: it.description, sortOrder: it.sortOrder, outstanding: moneyString(it.amount.minus(it.concessionAmount).minus(it.paidAmount).toString()) })),
    };
  });
}

