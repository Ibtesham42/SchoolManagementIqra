import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolationOf } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { moneyString, sumMoney, toMoney } from "@/lib/money";
import { enforce, RULES } from "@/lib/rate-limit";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertPortalStudent, PORTAL_NOT_FOUND, portalScopeOf } from "@/lib/rbac/portal-access";
import type { PortalWindow } from "@/lib/rbac/portal-scope";
import { getPortalSettings } from "@/modules/settings/settings.public";
import { portalWindow } from "@/modules/students/students.portal";
import { BACKDATE_DAYS } from "./collection.service";
import { openInvoicesOf } from "./ledger-reads.tx";
import { canonicalClaimRef, liveReceiptRefWhere, type SubmitClaimInput } from "./payment-claims.schemas";

/**
 * Phase 6C-M3 (P19) — "Pay by UPI" for PARENT accounts: the school's UPI ID and the amount due today, then the parent
 * reports the payment (amount, UPI / bank transfer, reference, date). Nothing is marked paid until an Accountant
 * confirms it against the bank statement (payment-claims.service).
 * - Who: a guardian account that may see the child's fees (`assertPortalStudent(…, "fees")` — blocked links and leavers
 *   outside the window refused; students never) AND holds `fee.pay.online` at CHILDREN. Anything else: the same NotFound.
 * - Limits: amount ≤ what is due today (counter rule, live late fee); payment date today or up to the counter's
 *   back-dating limit; a reference used by a live receipt or an open / confirmed claim is refused; at most 3 waiting
 *   claims per child; 5 claims a day per account (rate limit).
 * - The parent sees each claim's status only — never the office's reason or who decided.
 */
const MAX_OPEN = 3;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const LIVE_CLAIM_REF = { index: "fee_payment_claim_live_ref_key", fields: ["transactionRef"] };
const USED_REF = "This reference was already used for a payment to the school. Check the reference in your UPI or bank app.";

/** After assertPortalStudent(…, "fees"): a guardian account holding the claim permission at CHILDREN. */
function assertClaimant(ctx: AuthContext): void {
  if (!ctx.portal || ctx.portal.kind !== "GUARDIAN" || portalScopeOf(ctx)("fee.pay.online") !== "CHILDREN") throw new NotFoundError(PORTAL_NOT_FOUND);
}

export interface PortalClaim {
  id: string;
  amount: string;
  method: "UPI" | "BANK_TRANSFER";
  refEnd: string;
  paidOn: string;
  status: "SUBMITTED" | "CONFIRMED" | "REJECTED";
  /** Review 6C-M3 L6: the receipt a confirmation issued was cancelled later. */
  receiptCancelled: boolean;
  createdAt: Date;
}

/** The page: UPI details (null when the school hasn't set them), due today, this child's recent claims. */
export async function getPortalPayPage(ctx: AuthContext, studentId: string, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, studentId, "fees", w);
  assertClaimant(ctx);
  const [settings, open, student, claims] = await Promise.all([
    getPortalSettings(),
    openInvoicesOf(prisma, studentId, w.today),
    prisma.student.findUniqueOrThrow({ where: { id: studentId }, select: { studentCode: true, firstName: true } }),
    prisma.feePaymentClaim.findMany({ where: { studentId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10, select: { id: true, amount: true, method: true, transactionRef: true, paidOn: true, status: true, createdAt: true, payment: { select: { status: true } } } }),
  ]);
  const due = sumMoney(open.flatMap((o) => [o.balance, o.lateFee]));
  return {
    upi: settings.upi,
    dueToday: moneyString(due),
    studentCode: student.studentCode,
    firstName: student.firstName,
    today: w.today,
    earliest: iso(new Date(day(w.today).getTime() - BACKDATE_DAYS * 86_400_000)),
    claims: claims.map<PortalClaim>((c) => ({ id: c.id, amount: moneyString(c.amount.toString()), method: c.method, refEnd: c.transactionRef.slice(-4), paidOn: iso(c.paidOn), status: c.status, receiptCancelled: c.payment?.status === "CANCELLED", createdAt: c.createdAt })),
  };
}

/** Records the parent's claim (SUBMITTED). Insert only — no student lock (plan §2.6); the partial unique decides races. */
export async function submitPortalClaim(ctx: AuthContext, input: SubmitClaimInput, window?: PortalWindow) {
  const w = window ?? (await portalWindow());
  assertPortalStudent(ctx, input.studentId, "fees", w);
  assertClaimant(ctx);
  // Review 6C-M3 L1: the form is hidden while the school has no UPI details; a direct post is refused the same way.
  if (!(await getPortalSettings()).upi) throw new ConflictError("The school doesn't take UPI payments through the portal at the moment.");
  const ref = canonicalClaimRef(input.method, input.transactionRef);
  if (!ref) {
    const msg = input.method === "UPI" ? "Enter the 12-digit UPI transaction reference (UTR) from your UPI app." : "Enter the bank's transaction reference (6–30 letters and digits).";
    throw new ValidationError(msg, [{ path: "transactionRef", message: msg }]);
  }
  if (input.paidOn > w.today) throw new ValidationError("The payment date can't be in the future.", [{ path: "paidOn", message: "Future date." }]);
  const earliest = iso(new Date(day(w.today).getTime() - BACKDATE_DAYS * 86_400_000));
  if (input.paidOn < earliest) throw new ValidationError(`Payments older than ${BACKDATE_DAYS} days can't be reported here. Please contact the school office.`, [{ path: "paidOn", message: "Too far back." }]);
  await enforce(RULES.paymentClaim, ctx.userId);
  const amount = toMoney(input.amount);
  const [open, waiting, used] = await Promise.all([
    openInvoicesOf(prisma, input.studentId, w.today),
    prisma.feePaymentClaim.count({ where: { studentId: input.studentId, status: "SUBMITTED" } }),
    prisma.feePayment.findFirst({ where: liveReceiptRefWhere(ref), select: { id: true } }),
  ]);
  const due = sumMoney(open.flatMap((o) => [o.balance, o.lateFee]));
  if (due.lte(0)) throw new ConflictError("Nothing is due right now.");
  if (amount.gt(due)) throw new ValidationError(`The amount is more than what is due today (₹${moneyString(due)}).`, [{ path: "amount", message: "More than due." }]);
  if (waiting >= MAX_OPEN) throw new ConflictError("The school hasn't checked your earlier payments yet. Please wait for them first.");
  if (used) throw new ConflictError(USED_REF);
  try {
    const c = await prisma.$transaction(async (tx) => {
      const row = await tx.feePaymentClaim.create({ data: { studentId: input.studentId, amount: amount.toString(), method: input.method, transactionRef: ref, paidOn: day(input.paidOn), submittedById: ctx.userId }, select: { id: true } });
      // Ids, method and date only — never the amount or the reference (as with counter collections).
      await audit(tx, actorOf(ctx), { action: "fee_claim.submit", entityType: "FeePaymentClaim", entityId: row.id, after: { studentId: input.studentId, method: input.method, paidOn: input.paidOn } });
      return row;
    });
    return c;
  } catch (e) {
    if (isUniqueViolationOf(e, LIVE_CLAIM_REF)) throw new ConflictError(USED_REF);
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    throw e;
  }
}
