import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { moneyString } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { afterCommit, type NotificationDraft } from "@/modules/notifications/notifications.service";
import { familyRecipientsOf } from "@/modules/students/family-recipients.tx";
import { BACKDATE_DAYS, collectInTx, mapCollectionErrors, prepareCollection } from "./collection.service";
import type { CollectInput } from "./collection.schemas";
import { receiptNotifications } from "./fees.notify";
import { authorizeFeeWrite } from "./fees.policy";
import { lockFeeStudent } from "./fees.tx";
import { liveReceiptRefWhere, type ClaimRefInput, type RejectClaimInput } from "./payment-claims.schemas";

/**
 * Phase 6C-M3 (P19, ADR-048) — the office side of parents' UPI / bank-transfer intimations.
 *
 * - The queue, confirm and reject: `fee.collect` at ALL (the Accountant; Super Admin). A claim never marks anything
 *   paid by itself.
 * - CONFIRM = an ordinary counter collection of the claimed amount, by the confirming Accountant, through the SAME
 *   code path (`collectInTx`: student lock, open invoices oldest first, late fee as of today, allocation, receipt
 *   number from the sequence, snapshot, audit) in ONE transaction with the claim's status change. Lock order: student
 *   (advisory) → claim row FOR UPDATE → invoice rows ORDER BY id → sequence — two Accountants confirming at once get
 *   exactly one receipt (the second sees the claim no longer SUBMITTED). Over-claim beyond the dues, a reference already
 *   on a live receipt, a payment date beyond the counter's back-dating limit: the collection refuses, nothing changes.
 * - REJECT frees the reference (the partial unique covers SUBMITTED / CONFIRMED only). The reason is office-only; the
 *   parent sees the status.
 * - The submitter never decides (also a CHECK). Audit rows carry ids, method and status — never the amount, the
 *   reference or the reason. Families are told after commit (in-app, P23).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const NOT_FOUND = "Claim not found.";

export const canDecideClaims = (ctx: AuthContext) => {
  try {
    authorizeFeeWrite(ctx, "fee.collect");
    return !ctx.portal;
  } catch {
    return false;
  }
};
const requireDecider = (ctx: AuthContext) => {
  if (ctx.portal) throw new ForbiddenError();
  authorizeFeeWrite(ctx, "fee.collect");
};

const METHOD_LABEL = { UPI: "UPI", BANK_TRANSFER: "Bank transfer" } as const;

/** The queue (waiting claims, oldest first) and the most recent decisions. */
export async function listPaymentClaims(ctx: AuthContext) {
  requireDecider(ctx);
  const select = {
    id: true,
    version: true,
    amount: true,
    method: true,
    transactionRef: true,
    paidOn: true,
    status: true,
    createdAt: true,
    decidedAt: true,
    rejectReason: true,
    submittedById: true,
    student: { select: { id: true, studentCode: true, fullName: true } },
    submittedBy: { select: { displayName: true } },
    decidedBy: { select: { displayName: true } },
    payment: { select: { id: true, receiptNo: true } },
  } as const;
  const [waiting, decided] = await Promise.all([
    prisma.feePaymentClaim.findMany({ where: { status: "SUBMITTED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 100, select }),
    prisma.feePaymentClaim.findMany({ where: { status: { not: "SUBMITTED" } }, orderBy: [{ decidedAt: "desc" }, { id: "desc" }], take: 30, select }),
  ]);
  const shape = (c: (typeof waiting)[number]) => ({
    id: c.id,
    version: c.version,
    amount: moneyString(c.amount.toString()),
    method: METHOD_LABEL[c.method],
    transactionRef: c.transactionRef,
    paidOn: iso(c.paidOn),
    status: c.status,
    createdAt: c.createdAt,
    decidedAt: c.decidedAt,
    rejectReason: c.rejectReason,
    student: { id: c.student.id, studentCode: c.student.studentCode, fullName: c.student.fullName },
    submittedBy: c.submittedBy?.displayName ?? null,
    decidedBy: c.decidedBy?.displayName ?? null,
    receipt: c.payment ? { id: c.payment.id, receiptNo: c.payment.receiptNo } : null,
    mine: c.submittedById === ctx.userId,
  });
  return { waiting: waiting.map(shape), decided: decided.map(shape) };
}

async function claimNotifications(claimId: string): Promise<NotificationDraft[]> {
  const c = await prisma.feePaymentClaim.findUnique({ where: { id: claimId }, select: { studentId: true, status: true } });
  if (!c || c.status === "SUBMITTED") return [];
  const recipients = await familyRecipientsOf(prisma, [c.studentId], { students: false });
  return recipients.map((r) => ({
    userId: r.userId,
    type: c.status === "CONFIRMED" ? ("fee.claim_confirmed" as const) : ("fee.claim_rejected" as const),
    title: c.status === "CONFIRMED" ? "Payment confirmed" : "Payment not confirmed",
    body: c.status === "CONFIRMED" ? `The school confirmed your payment for ${r.firstName}. The receipt is in the Fees tab.` : `The school couldn't confirm a payment you reported for ${r.firstName}. Please contact the school office.`,
    link: `/portal/c/${encodeURIComponent(r.studentId)}/fees`,
    dedupeKey: `claim:${r.studentId}:${claimId}`,
  }));
}

/** Confirm: one ordinary receipt for the claimed amount, issued through the counter's collection path. */
export async function confirmPaymentClaim(ctx: AuthContext, input: ClaimRefInput) {
  requireDecider(ctx);
  const peek = await prisma.feePaymentClaim.findUnique({ where: { id: input.id }, select: { studentId: true, amount: true, method: true, transactionRef: true, paidOn: true, submittedById: true, createdAt: true } });
  if (!peek) throw new NotFoundError(NOT_FOUND);
  if (peek.submittedById === ctx.userId) throw new ForbiddenError("You can't confirm a payment you reported yourself.");
  const collect: CollectInput = {
    studentId: peek.studentId,
    amount: moneyString(peek.amount.toString()).replace(/,/g, ""),
    method: peek.method,
    transactionRef: peek.transactionRef,
    bankName: null,
    instrumentDate: null,
    paidOn: iso(peek.paidOn),
    invoiceIds: [],
    waiveLateFeeInvoiceIds: [],
    waiveReason: null,
    // One receipt per claim, whatever happens: a second confirm finds the claim decided, and the key is unique anyway.
    idempotencyKey: `claim:${input.id}`,
  };
  // Review 6C-M3 L3: back-dating counts from the day the parent reported it (+ the counter's limit), at most 60 days.
  const waited = Math.max(0, Math.floor((Date.now() - peek.createdAt.getTime()) / 86_400_000));
  const prep = { ...(await prepareCollection(ctx, collect)), maxBackdateDays: Math.min(60, BACKDATE_DAYS + waited) };
  let receipt: { id: string; receiptNo: string };
  try {
    receipt = await prisma.$transaction(
      async (tx) => {
        await lockFeeStudent(tx, peek.studentId);
        const [row] = await tx.$queryRaw<{ status: string; version: number; student_id: string }[]>`SELECT status::text AS status, version, student_id FROM fee_payment_claim WHERE id = ${input.id} FOR UPDATE`;
        if (!row || row.student_id !== peek.studentId) throw new NotFoundError(NOT_FOUND);
        if (row.status !== "SUBMITTED") throw new ConflictError("This claim was already decided. Reload the page.");
        if (row.version !== input.version) throw new ConflictError("This claim was changed by someone else. Reload the page and try again.");
        // Review 6C-M3 M1: under the student lock, a live receipt carrying this reference in any counter form refuses.
        if (await tx.feePayment.findFirst({ where: liveReceiptRefWhere(peek.transactionRef), select: { id: true } })) throw new ConflictError("This reference is already on a receipt. Reject the claim after checking with the parent.");
        const r = await collectInTx(tx, ctx, collect, prep);
        if (r.replay) throw new ConflictError("This claim was already confirmed. Reload the page.");
        await tx.feePaymentClaim.update({ where: { id: input.id }, data: { status: "CONFIRMED", paymentId: r.id, decidedById: ctx.userId, decidedAt: new Date(), version: { increment: 1 } } });
        await audit(tx, actorOf(ctx), { action: "fee_claim.confirm", entityType: "FeePaymentClaim", entityId: input.id, after: { paymentId: r.id, receiptNo: r.receiptNo, method: peek.method } });
        return { id: r.id, receiptNo: r.receiptNo };
      },
      { timeout: 20_000 },
    );
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ConflictError || e instanceof ForbiddenError) throw e;
    return mapCollectionErrors(e);
  }
  await afterCommit("claim-confirm", async () => [...(await receiptNotifications(receipt.id, "issued")), ...(await claimNotifications(input.id))]);
  return receipt;
}

/** Reject with an office-only reason; the reference becomes free for a corrected claim. */
export async function rejectPaymentClaim(ctx: AuthContext, input: RejectClaimInput) {
  requireDecider(ctx);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '5s', true) AS lock_timeout`;
      const [row] = await tx.$queryRaw<{ status: string; version: number; submitted_by_id: string | null }[]>`SELECT status::text AS status, version, submitted_by_id FROM fee_payment_claim WHERE id = ${input.id} FOR UPDATE`;
      if (!row) throw new NotFoundError(NOT_FOUND);
      if (row.submitted_by_id === ctx.userId) throw new ForbiddenError("You can't decide a payment you reported yourself.");
      if (row.status !== "SUBMITTED") throw new ConflictError("This claim was already decided. Reload the page.");
      if (row.version !== input.version) throw new ConflictError("This claim was changed by someone else. Reload the page and try again.");
      await tx.feePaymentClaim.update({ where: { id: input.id }, data: { status: "REJECTED", rejectReason: input.reason, decidedById: ctx.userId, decidedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_claim.reject", entityType: "FeePaymentClaim", entityId: input.id });
    });
  } catch (e) {
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
  await afterCommit("claim-reject", () => claimNotifications(input.id));
}

