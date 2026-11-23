import { createElement } from "react";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { moneyString, sumMoney } from "@/lib/money";
import { renderPdf } from "@/lib/pdf/render";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent, PORTAL_NOT_FOUND, portalScopeOf, portalVisibleChildren } from "@/lib/rbac/portal-access";
import { portalCanSee, type PortalWindow } from "@/lib/rbac/portal-scope";
import { loadBranding } from "@/modules/documents/documents.service";
import { FeeReceiptDocument } from "@/modules/documents/templates/fee-receipt";
import { portalWindow } from "@/modules/students/students.portal";
import { openInvoicesOf } from "./ledger-reads.tx";
import { readSnapshot } from "./receipts.service";

/**
 * Phase 6B-M3 (P13, FC22) — the fee ledger for PARENTS (students never: no `fee.read` and `portalCanSee` refuses STUDENT
 * fees). Leavers keep it inside the window (P17). Every read: `assertPortalStudent(…, "fees")` first; by-id reads load
 * the owning student, then check — the identical NotFound for anything not this account's.
 *
 * Whitelist (P13, KI-105): invoice number, session, installment, due date, status, amounts; line labels — the fee head
 * text for STRUCTURE / CHARGE lines, FIXED labels for LATE_FEE ("Late fee", "Late fee waived") and OPENING_BALANCE
 * ("Previous dues"). NEVER: concession / cancellation / waiver reasons, LATE_FEE line text, references, collectors,
 * staff names. The live late fee "as of today" is worked out exactly as at the counter (`openInvoicesOf`).
 * Receipt PDFs: the published receipt snapshot, stamped PARENT COPY, without reference / bank / instrument date /
 * collector; never counted as a print (the counter's ORIGINAL / DUPLICATE count is untouched); audited as a view.
 */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const actorOf = (ctx: AuthContext) => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const METHOD_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", CHEQUE: "Cheque", CARD: "Card" };
const STATUS_LABEL: Record<string, string> = { ISSUED: "Due", PARTIAL: "Part paid", PAID: "Paid", WAIVED: "Waived" };

/**
 * Review 6B-M3 L1: waivers are still written the pre-KI-105 way (a zero LATE_FEE line, the amount and reason in its
 * text, `waivedAmount` null), so the label comes from what the line IS: a zero LATE_FEE line never paid against is a
 * waiver; a zero one WITH allocation history was voided by a receipt cancellation (hidden from families — `null`).
 */
export function portalLineLabel(it: { kind: string; description: string; waivedAmount: unknown; amount: string; allocationCount: number }): string | null {
  if (it.kind === "LATE_FEE") {
    const zero = Number(it.amount) === 0;
    if ((it.waivedAmount !== null && it.waivedAmount !== undefined) || (zero && it.allocationCount === 0)) return "Late fee waived";
    if (zero) return null;
    return "Late fee";
  }
  if (it.kind === "OPENING_BALANCE") return "Previous dues";
  return it.description;
}

/** Receipt snapshot lines carry no item kind: previous dues are recognised by their installment, late fees by text. */
export function portalReceiptLineLabel(l: { installment: string; description: string }): string {
  if (l.installment === "Previous dues") return "Previous dues";
  if (/late\s*fee/i.test(l.description)) return "Late fee";
  return l.description;
}

export interface PortalInvoice {
  id: string;
  invoiceNo: string;
  sessionName: string;
  installmentName: string;
  dueOn: string;
  status: string;
  overdue: boolean;
  total: string;
  paid: string;
  balance: string;
  /** Live late fee as of today (open invoices only; "0.00" once fixed or waived). */
  lateFeeToday: string;
  lines: { label: string; amount: string; concession: string; paid: string }[];
}

export async function getPortalFeeLedger(ctx: AuthContext, studentId: string, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "fees", w);
  const [invoices, open, receipts] = await Promise.all([
    prisma.feeInvoice.findMany({
      where: { studentId, deletedAt: null, status: { not: "CANCELLED" }, student: { deletedAt: null } },
      orderBy: [{ dueOn: "desc" }, { invoiceNo: "desc" }],
      take: 100,
      select: {
        id: true,
        invoiceNo: true,
        dueOn: true,
        status: true,
        total: true,
        paidAmount: true,
        enrollment: { select: { academicSession: { select: { name: true } } } },
        installment: { select: { name: true } },
        items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], take: 50, select: { kind: true, description: true, amount: true, concessionAmount: true, paidAmount: true, waivedAmount: true, _count: { select: { allocations: true } } } },
      },
    }),
    openInvoicesOf(prisma, studentId, w.today),
    prisma.feePayment.findMany({
      where: { studentId },
      orderBy: [{ paidOn: "desc" }, { receiptNo: "desc" }],
      take: 100,
      select: { id: true, receiptNo: true, paidOn: true, amount: true, method: true, status: true },
    }),
  ]);
  const live = new Map(open.map((o) => [o.id, o.lateFee]));
  const items: PortalInvoice[] = invoices.map((i) => {
    const isOpen = i.status === "ISSUED" || i.status === "PARTIAL";
    const balance = i.total.minus(i.paidAmount);
    return {
      id: i.id,
      invoiceNo: i.invoiceNo,
      sessionName: i.enrollment.academicSession.name,
      installmentName: i.installment?.name ?? "Previous dues",
      dueOn: iso(i.dueOn),
      status: STATUS_LABEL[i.status] ?? i.status,
      overdue: isOpen && iso(i.dueOn) < w.today,
      total: moneyString(i.total.toString()),
      paid: moneyString(i.paidAmount.toString()),
      balance: moneyString(balance.toString()),
      lateFeeToday: isOpen ? (live.get(i.id) ?? "0.00") : "0.00",
      lines: i.items.flatMap((it) => {
        const label = portalLineLabel({ kind: it.kind, description: it.description, waivedAmount: it.waivedAmount, amount: it.amount.toString(), allocationCount: it._count.allocations });
        return label === null ? [] : [{ label, amount: moneyString(it.amount.toString()), concession: moneyString(it.concessionAmount.toString()), paid: moneyString(it.paidAmount.toString()) }];
      }),
    };
  });
  // Review 6B-M3 L2: the totals come from the counter's own open-invoice read (oldest first, open only), never from the
  // display list (newest first, bounded) — the parent sees exactly what the counter will collect.
  return {
    today: w.today,
    dueToday: moneyString(sumMoney(open.flatMap((o) => [o.balance, o.lateFee]))),
    overdueCount: open.filter((o) => o.dueOn < w.today).length,
    invoices: items,
    receipts: receipts.map((p) => ({ id: p.id, receiptNo: p.receiptNo, paidOn: iso(p.paidOn), amount: moneyString(p.amount.toString()), method: METHOD_LABEL[p.method] ?? p.method, cancelled: p.status === "CANCELLED" })),
  };
}

/** FC22 in-app: how many of this account's children have an overdue invoice (portal home banner). One count query. */
export async function portalOverdueChildren(ctx: AuthContext, window?: PortalWindow): Promise<number> {
  if (!ctx.portal) return 0;
  const w = window ?? (await portalWindow());
  const scopeOf = portalScopeOf(ctx);
  const ids = portalVisibleChildren(ctx, w)
    .filter((c) => portalCanSee(ctx.portal!, scopeOf, c.studentId, "fees", w))
    .map((c) => c.studentId);
  if (ids.length === 0) return 0;
  authorize(ctx, "fee.read");
  // Review 6B-M3 L3: grouped in the database — one row per child at most, whatever the number of invoices.
  const rows = await prisma.feeInvoice.groupBy({
    by: ["studentId"],
    where: { studentId: { in: ids }, deletedAt: null, status: { in: ["ISSUED", "PARTIAL"] }, dueOn: { lt: new Date(`${w.today}T00:00:00Z`) } },
  });
  return rows.length;
}

/** GET /api/v1/portal/receipts/[id]/pdf — the parent copy of one receipt (valid or cancelled). */
export async function renderPortalReceiptPdf(ctx: AuthContext, id: string, window?: PortalWindow): Promise<{ pdf: Buffer; fileName: string }> {
  authorize(ctx, "fee.read");
  if (!ctx.portal) throw new NotFoundError(PORTAL_NOT_FOUND); // staff use the staff route (before any database access)
  const w = window ?? (await portalWindow());
  const p = await prisma.feePayment.findUnique({
    where: { id },
    select: { id: true, studentId: true, receiptNo: true, amount: true, paidOn: true, status: true, receiptSnapshot: true, student: { select: { deletedAt: true } } },
  });
  if (!p || p.student.deletedAt) throw new NotFoundError(PORTAL_NOT_FOUND);
  assertPortalStudent(ctx, p.studentId, "fees", w);
  const snap = readSnapshot(p.receiptSnapshot);
  const branding = await loadBranding();
  const pdf = await renderPdf(
    createElement(FeeReceiptDocument, {
      branding,
      receipt: {
        receiptNo: p.receiptNo,
        paidOn: formatDateOnly(new Date(`${iso(p.paidOn)}T00:00:00Z`)),
        student: snap.student,
        method: snap.method,
        // P13: no references, bank details or collector on the parent copy.
        reference: null,
        bankName: null,
        instrumentDate: null,
        // The ledger's whitelist on the snapshot lines: fixed labels for late fees and previous dues (KI-105).
        lines: snap.lines.map((l) => ({ ...l, description: portalReceiptLineLabel(l) })),
        amount: moneyString(p.amount.toString()),
        amountInWords: snap.amountInWords,
        collectedBy: null,
      },
      copy: "PARENT",
      cancelled: p.status === "CANCELLED",
      generatedAt: new Date(),
    }),
  );
  await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "fee_payment.portal_view", entityType: "FeePayment", entityId: p.id }));
  return { pdf, fileName: "receipt.pdf" };
}
