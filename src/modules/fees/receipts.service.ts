import { createElement } from "react";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { formatDateOnly, todayInTimeZone } from "@/lib/format";
import { renderPdf } from "@/lib/pdf/render";
import { moneyString, sumMoney, toMoney } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertReceiptRead, authorizeFeeWrite, holdsAll, receiptCancelRefusal, type ReceiptCancelRefusal } from "./fees.policy";
import { lockSessionShared } from "@/modules/academic/academic.tx";
import { loadBranding } from "@/modules/documents/documents.service";
import { FeeReceiptDocument, type ReceiptCopy } from "@/modules/documents/templates/fee-receipt";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { readFeeSettingsTx } from "@/modules/settings/settings.service";
import { lockFeeStudent } from "./fees.tx";
import type { CancelReceiptInput, ReceiptLookupInput } from "./receipts.schemas";

/**
 * Phase 5B-M3 — receipts: list, look up, view, cancel (PHASE_5_PLAN.md FC13, R3, R5; review 5A L5, §11 I4, §14).
 *
 * - Read: `fee.read`, `fee.collect` or `fee.refund` at ALL. The receipt is shown from its stored `receiptSnapshot`
 *   (never from current structures). The cancel reason is shown only to `fee.refund` holders (I4).
 * - Cancel (`fee.refund` ALL): never by the collector (also a database CHECK), a receipt whose collector is no longer a
 *   user only by a Super Admin; a canceller who also collects (Accountant) only on the day it was recorded; a closed
 *   session's receipt only by a Super Admin (review M2, owner 2026-11-22); reason required; nothing is deleted. Lock order as collection: per-student lock → the
 *   payment row → the invoices it paid (ORDER BY id). Live allocations are marked reversed, item and invoice paid
 *   amounts go down, invoices go back to ISSUED / PARTIAL. The receipt keeps its number; its reference is free again
 *   (the partial unique indexes count SUCCESS payments only).
 * - Late fee (review 5B-M3 M1): when the cancellation leaves an invoice with NO live payment, its frozen LATE_FEE lines
 *   and waiver lines are undone (removed, or voided to zero when allocation history references them) and the
 *   invoice's late fee and total go down — otherwise a bounced cheque would freeze a PER_DAY late fee low, and
 *   waive-then-cancel would waive it for good. While another live payment remains on the invoice, they stay.
 * Audit: receipt number, invoice ids and the invoices whose late fee was undone — never amounts, the reference or the
 * reason.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const METHOD_LABEL = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", CHEQUE: "Cheque", CARD: "Card" } as const;
export const RECEIPTS_PAGE_SIZE = 50;
/** Text of a frozen late-fee line voided by a cancellation (review 5B-M3 M1). Amount 0 + allocation history = void. */
export const VOID_LATE_FEE = "Late fee (void: receipt cancelled)";

const REFUSAL_MESSAGE: Record<ReceiptCancelRefusal, string> = {
  NOT_PERMITTED: "You can't cancel receipts.",
  ALREADY_CANCELLED: "This receipt is already cancelled.",
  OWN_COLLECTION: "You collected this payment, so someone else must cancel it.",
  COLLECTOR_UNKNOWN: "The person who collected this payment is no longer a user; only a Super Admin can cancel it.",
  NOT_SAME_DAY: "This receipt was recorded before today. Ask the Principal (or a Super Admin) to cancel it.",
  SESSION_CLOSED: "This receipt paid fees of a closed academic session; only a Super Admin can cancel it.",
};

/** Review 5B-M3 M2: the receipt's school-local recording day vs today. */
const recordedToday = (createdAt: Date, tz: string | undefined) => todayInTimeZone(tz, createdAt) === todayInTimeZone(tz);

/** Sessions of the invoices a payment still pays (live allocations). */
async function sessionIdsOf(db: Tx | typeof prisma, invoiceIds: string[]): Promise<string[]> {
  if (invoiceIds.length === 0) return [];
  const rows = await db.feeInvoice.findMany({ where: { id: { in: invoiceIds } }, select: { academicSessionId: true } });
  return [...new Set(rows.map((r) => r.academicSessionId))].sort();
}

/** Newest receipts first, one page (page/pageSize, never unbounded). */
export async function listReceipts(ctx: AuthContext, page: number) {
  assertReceiptRead(ctx);
  const rows = await prisma.feePayment.findMany({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * RECEIPTS_PAGE_SIZE,
    take: RECEIPTS_PAGE_SIZE + 1,
    select: {
      id: true,
      receiptNo: true,
      amount: true,
      method: true,
      paidOn: true,
      status: true,
      student: { select: { studentCode: true, fullName: true } },
      collectedBy: { select: { displayName: true } },
    },
  });
  return {
    hasMore: rows.length > RECEIPTS_PAGE_SIZE,
    receipts: rows.slice(0, RECEIPTS_PAGE_SIZE).map((r) => ({
      id: r.id,
      receiptNo: r.receiptNo,
      amount: moneyString(r.amount.toString()),
      method: METHOD_LABEL[r.method],
      paidOn: iso(r.paidOn),
      cancelled: r.status === "CANCELLED",
      studentCode: r.student.studentCode,
      studentName: r.student.fullName,
      collectedBy: r.collectedBy?.displayName ?? null,
    })),
  };
}

/** Exact receipt number → its id (or null). Tried as typed, then upper-cased (the unique index is used either way). */
export async function findReceiptId(ctx: AuthContext, input: ReceiptLookupInput): Promise<string | null> {
  assertReceiptRead(ctx);
  const tries = [...new Set([input.receiptNo, input.receiptNo.toUpperCase()])];
  const r = await prisma.feePayment.findFirst({ where: { receiptNo: { in: tries } }, select: { id: true } });
  return r?.id ?? null;
}

/** Snapshot fields the page prints (ADR-041 whitelist). Unknown or malformed snapshots show what is valid only. */
interface SnapshotLine {
  invoiceNo: string;
  session: string;
  installment: string;
  description: string;
  amount: string;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** Whitelisted reader of a receipt snapshot (pure; also used by the portal parent copy, Phase 6B-M3). */
export function readSnapshot(raw: unknown) {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const st = o.student && typeof o.student === "object" ? (o.student as Record<string, unknown>) : {};
  const lines: SnapshotLine[] = Array.isArray(o.lines)
    ? o.lines.flatMap((l): SnapshotLine[] => {
        if (!l || typeof l !== "object") return [];
        const x = l as Record<string, unknown>;
        const amount = str(x.amount);
        return amount ? [{ invoiceNo: str(x.invoiceNo) ?? "", session: str(x.session) ?? "", installment: str(x.installment) ?? "", description: str(x.description) ?? "", amount }] : [];
      })
    : [];
  return {
    school: str(o.school),
    student: { name: str(st.name) ?? "", studentCode: str(st.studentCode) ?? "", className: str(st.className) ?? "", sectionCode: str(st.sectionCode) ?? "" },
    method: str(o.method) ?? "",
    reference: str(o.reference),
    bankName: str(o.bankName),
    instrumentDate: str(o.instrumentDate),
    lines,
    amountInWords: str(o.amountInWords),
    collectedBy: str(o.collectedBy),
  };
}

/** One receipt, from its snapshot, plus whether this user may cancel it (and why not). */
export async function getReceipt(ctx: AuthContext, id: string) {
  assertReceiptRead(ctx);
  const canSeeReason = holdsAll(ctx, "fee.refund");
  const p = await prisma.feePayment.findUnique({
    where: { id },
    select: {
      id: true,
      receiptNo: true,
      studentId: true,
      amount: true,
      paidOn: true,
      status: true,
      version: true,
      collectedById: true,
      createdAt: true,
      receiptSnapshot: true,
      printCount: true,
      cancelledAt: true,
      cancelReason: canSeeReason,
      cancelledBy: { select: { displayName: true } },
      allocations: { where: { reversedAt: null }, select: { invoiceId: true } },
    },
  });
  if (!p) throw new NotFoundError("Receipt not found.");
  const tz = (await getSchoolTimezone()) ?? undefined;
  const sessionIds = await sessionIdsOf(prisma, [...new Set(p.allocations.map((a) => a.invoiceId))]);
  const closed = sessionIds.length > 0 && (await prisma.academicSession.count({ where: { id: { in: sessionIds }, status: "CLOSED" } })) > 0;
  const refusal = receiptCancelRefusal(ctx, { status: p.status, collectedById: p.collectedById, recordedToday: recordedToday(p.createdAt, tz), closedSession: closed });
  return {
    id: p.id,
    receiptNo: p.receiptNo,
    studentId: p.studentId,
    amount: moneyString(p.amount.toString()),
    paidOn: iso(p.paidOn),
    recordedAt: p.createdAt.toISOString(),
    version: p.version,
    printCount: p.printCount,
    /** Review 5B-M2 L2: this user's prints count (ORIGINAL / DUPLICATE); others get a non-counting office copy. */
    printCounts: holdsAll(ctx, "fee.collect"),
    cancelled: p.status === "CANCELLED",
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    cancelledBy: p.cancelledBy?.displayName ?? null,
    cancelReason: canSeeReason ? (p.cancelReason ?? null) : null,
    ...readSnapshot(p.receiptSnapshot),
    canCancel: refusal === null,
    // Explain only to people who could otherwise cancel (a reader without fee.refund sees no cancel section).
    cancelBlockedReason: refusal && refusal !== "NOT_PERMITTED" && refusal !== "ALREADY_CANCELLED" ? REFUSAL_MESSAGE[refusal] : null,
  };
}

/** Cancel a receipt (FC13): reverse its allocations and restore the invoices' balances in ONE transaction. */
export async function cancelReceipt(ctx: AuthContext, input: CancelReceiptInput) {
  authorizeFeeWrite(ctx, "fee.refund");
  try {
    return await prisma.$transaction(
      async (tx) => {
        const head = await tx.feePayment.findUnique({ where: { id: input.id }, select: { studentId: true, allocations: { where: { reversedAt: null }, select: { invoiceId: true } } } });
        if (!head) throw new NotFoundError("Receipt not found.");
        // Review 5B-M2 L1: sessions FOR SHARE FIRST (a concurrent close waits) — the same order as concession approval
        // (session → student). A payment's live allocations only ever shrink and an invoice's session never changes, so
        // the sessions read here cover every invoice still paid once the payment row is locked.
        const statusOf = new Map<string, string>();
        for (const sid of await sessionIdsOf(tx, [...new Set(head.allocations.map((a) => a.invoiceId))])) statusOf.set(sid, await lockSessionShared(tx, sid));
        await lockFeeStudent(tx, head.studentId);
        await tx.$queryRaw`SELECT id FROM fee_payment WHERE id = ${input.id} FOR UPDATE`;
        const p = await tx.feePayment.findUniqueOrThrow({
          where: { id: input.id },
          select: { receiptNo: true, amount: true, status: true, version: true, collectedById: true, createdAt: true, allocations: { where: { reversedAt: null }, select: { invoiceId: true, invoiceItemId: true, amount: true } } },
        });
        if (p.version !== input.version) throw new ConflictError("This receipt was changed by someone else. Reload the page and try again.");
        // Invariant (FC8): Σ live allocations = the payment. Anything else is data damage — stop, change nothing.
        if (p.status === "SUCCESS" && !sumMoney(p.allocations.map((a) => a.amount.toString())).eq(toMoney(p.amount.toString()))) throw new Error("fee_payment allocations do not add up to the payment");
        const invoiceIds = [...new Set(p.allocations.map((a) => a.invoiceId))].sort();
        if (invoiceIds.length > 0) await tx.$queryRaw`SELECT id FROM fee_invoice WHERE id = ANY(${invoiceIds}) ORDER BY id FOR UPDATE`;
        // Review M2: the same-day / closed-session rules (sessions locked above).
        const sessionIds = await sessionIdsOf(tx, invoiceIds);
        if (sessionIds.some((sid) => !statusOf.has(sid))) throw new ConflictError("This receipt was changed by someone else. Reload the page and try again.");
        const closed = sessionIds.some((sid) => statusOf.get(sid) === "CLOSED");
        const tz = (await readFeeSettingsTx(tx)).timezone ?? undefined;
        const refusal = receiptCancelRefusal(ctx, { status: p.status, collectedById: p.collectedById, recordedToday: recordedToday(p.createdAt, tz), closedSession: closed });
        if (refusal === "ALREADY_CANCELLED") throw new ConflictError(REFUSAL_MESSAGE[refusal]);
        if (refusal) throw new ForbiddenError(REFUSAL_MESSAGE[refusal]);
        const now = new Date();
        await tx.feePaymentAllocation.updateMany({ where: { paymentId: input.id, reversedAt: null }, data: { reversedAt: now } });
        for (const a of p.allocations) await tx.feeInvoiceItem.update({ where: { id: a.invoiceItemId }, data: { paidAmount: { decrement: a.amount } } });
        const unfrozen: string[] = [];
        for (const invoiceId of invoiceIds) {
          const inv = await tx.feeInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { paidAmount: true, total: true } });
          const paid = inv.paidAmount.minus(sumMoney(p.allocations.filter((a) => a.invoiceId === invoiceId).map((a) => a.amount.toString())).toString());
          // Review 5B-M3 M1: with no live payment left on the invoice, nothing justifies its frozen late fee or waiver —
          // undo them, so the next collection works the late fee out again from the due date and a waiver must be
          // given again with a payment that stands. Lines no allocation ever referenced are removed; a line with
          // (reversed) allocation history can't be (FK) and is voided to zero. While another live payment remains, the
          // lines stay (that payment froze them).
          let lateRemoved = toMoney("0");
          if (paid.isZero()) {
            const late = await tx.feeInvoiceItem.findMany({ where: { invoiceId, kind: "LATE_FEE" }, select: { id: true, amount: true, _count: { select: { allocations: true } } } });
            for (const it of late) {
              lateRemoved = lateRemoved.plus(it.amount.toString());
              if (it._count.allocations === 0) await tx.feeInvoiceItem.delete({ where: { id: it.id } });
              else if (!it.amount.isZero()) await tx.feeInvoiceItem.update({ where: { id: it.id }, data: { amount: "0.00", description: VOID_LATE_FEE } });
            }
            if (late.length > 0) unfrozen.push(invoiceId);
          }
          const total = toMoney(inv.total.toString()).minus(lateRemoved);
          const status = paid.isZero() ? (total.gt(0) ? "ISSUED" : "WAIVED") : "PARTIAL";
          await tx.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount: paid.toString(), lateFee: { decrement: lateRemoved.toFixed(2) }, total: total.toFixed(2), status, version: { increment: 1 } } });
        }
        await tx.feePayment.update({ where: { id: input.id }, data: { status: "CANCELLED", cancelledAt: now, cancelledById: ctx.userId, cancelReason: input.reason, version: { increment: 1 } } });
        // Review L1: the invoices (ids are not sensitive) and which had their late fee undone — never amounts or the reason.
        await audit(tx, actorOf(ctx), { action: "fee_payment.cancel", entityType: "FeePayment", entityId: input.id, before: { status: "SUCCESS" }, after: { status: "CANCELLED", receiptNo: p.receiptNo, invoiceIds, ...(unfrozen.length ? { lateFeeUnfrozen: unfrozen } : {}) } });
        return { receiptNo: p.receiptNo, invoices: invoiceIds.length };
      },
      { timeout: 20_000 },
    );
  } catch (e) {
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
}

/**
 * Phase 5B-M2 (FC14): the receipt PDF, from its snapshot. Readers of receipts only.
 * - Review 5B-M2 L2: only people who hand receipts over (`fee.collect`) count prints — their first print is the
 *   ORIGINAL, later ones say DUPLICATE. Other readers (Principal, School Admin) get a non-counting COPY, still audited.
 * - Review L3: rendered FIRST (CPU work outside any transaction), then the print is counted under the student lock
 *   (review 5B-M3 L2) only if the count and status are what the render used; otherwise it renders again — a failed
 *   render never uses up the ORIGINAL. print_count only grows (trigger); the version is NOT bumped (a print must not
 *   make an open cancel form stale).
 */
export async function renderReceiptPdf(ctx: AuthContext, id: string): Promise<{ pdf: Buffer; fileName: string }> {
  assertReceiptRead(ctx);
  const counts = holdsAll(ctx, "fee.collect");
  const branding = await loadBranding();
  const dateText = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? formatDateOnly(new Date(`${s}T00:00:00.000Z`)) : s);
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await prisma.feePayment.findUnique({ where: { id }, select: { studentId: true, receiptNo: true, amount: true, paidOn: true, status: true, printCount: true, receiptSnapshot: true } });
    if (!p) throw new NotFoundError("Receipt not found.");
    const copy: ReceiptCopy = !counts ? "COPY" : p.printCount > 0 ? "DUPLICATE" : "ORIGINAL";
    const snap = readSnapshot(p.receiptSnapshot);
    const pdf = await renderPdf(
      createElement(FeeReceiptDocument, {
        branding,
        receipt: {
          receiptNo: p.receiptNo,
          paidOn: dateText(iso(p.paidOn)) ?? "",
          student: snap.student,
          method: snap.method,
          reference: snap.reference,
          bankName: snap.bankName,
          instrumentDate: dateText(snap.instrumentDate),
          lines: snap.lines,
          amount: moneyString(p.amount.toString()),
          amountInWords: snap.amountInWords,
          collectedBy: snap.collectedBy,
        },
        copy,
        cancelled: p.status === "CANCELLED",
        generatedAt: new Date(),
      }),
    );
    const recorded = await prisma
      .$transaction(
        async (tx) => {
          await lockFeeStudent(tx, p.studentId);
          const n = counts
            ? await tx.$executeRaw`UPDATE fee_payment SET print_count = print_count + 1 WHERE id = ${id} AND print_count = ${p.printCount} AND status = ${p.status}::"FeePaymentStatus"`
            : (await tx.feePayment.count({ where: { id, status: p.status } }));
          if (n === 0) return false; // printed or cancelled meanwhile: render again with the right stamp
          await audit(tx, actorOf(ctx), { action: "fee_payment.print", entityType: "FeePayment", entityId: id, after: { receiptNo: p.receiptNo, copy: counts ? p.printCount + 1 : "view" } });
          return true;
        },
        { timeout: 10_000 },
      )
      .catch((e: unknown) => {
        if (isTransactionBusy(e)) throw new ServiceBusyError();
        throw e;
      });
    if (recorded) {
      const safe = p.receiptNo.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "receipt";
      return { pdf, fileName: `fee-receipt-${safe}.pdf` };
    }
  }
  throw new ServiceBusyError();
}
