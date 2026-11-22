import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation, isUniqueViolationOf } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { amountInWordsIndian, moneyString, sumMoney, toMoney } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { formatSequence, nextSequence, sequenceKey } from "@/lib/sequence";
import { getSchoolName } from "@/modules/settings/settings.public";
import { readFeeSettingsTx } from "@/modules/settings/settings.service";
import { latestEnrollment, searchStudentsAnySession } from "@/modules/students/enrollment-reads.tx";
import { AllocationError, allocatePayment, type OpenInvoice } from "./allocation";
import { lateFeeFor, type LateFeeRule } from "./fee-calc";
import { lateFeeFrozen, normalizeBankName, normalizeReferenceFor } from "./fee-rules";
import { authorizeFeeWrite, holdsAll } from "./fees.policy";
import { lockFeeStudent } from "./fees.tx";
import type { CollectInput } from "./collection.schemas";

/**
 * Phase 5B-M1 — counter collection (PHASE_5_PLAN.md FC7–FC12, FC15, FC25; ADR-041; reviews §10 L7, §12 L7, §13, §14).
 *
 * - `fee.collect` at ALL (the Accountant). Lock order: per-student advisory lock → the student's open invoices FOR UPDATE
 *   (ORDER BY id; only the locked rows are read) → receipt sequence LAST. Re-pricing takes fee setup → the same student
 *   lock → rows, so the two serialize without a cycle.
 * - Idempotency (FC15): the form carries a random key; it is checked again UNDER the student lock (review 5B-M1 L1). A
 *   replay with the same key, collector, student and amount returns the existing receipt; anything else conflicts.
 * - Dates (review M1): the payment date is today or up to BACKDATE_DAYS earlier; backdating is audited. The late fee is
 *   always worked out as of TODAY and the receipt-number year comes from TODAY, whatever the payment date.
 * - Late fee (FC7): frozen as a LATE_FEE item on every invoice the payment touches. A waiver needs
 *   `fee.concession.manage`, applies only to invoices this payment touches (review M3), and is kept on the invoice as a
 *   zero LATE_FEE line whose text records the waived amount and the reason (review M2; read by fee staff only, never
 *   audited — KI-105 tracks moving it to its own columns).
 * - Allocation (FC8 / FC9): oldest due first (optionally limited to chosen invoices), late fee last; over-payment refused.
 * - References (FC10 / FC11): UPI / bank transfer / card compare as letters and digits only (review L6); cheques need
 *   bank + date (no post-dated or stale cheques); uniqueness among SUCCESS payments by partial unique indexes.
 * - Receipt (ADR-041): the payment row IS the receipt; its number from lib/sequence only on success; `receiptSnapshot`
 *   is a WHITELIST of what the PDF prints (no Aadhaar, medical, guardian phone or address).
 * Audit: receipt number, method, date, invoice count and a backdated flag — never the amount or the reference.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const daysBetween = (a: string, b: string) => Math.round((day(a).getTime() - day(b).getTime()) / 86_400_000);
const METHOD_LABEL = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", CHEQUE: "Cheque", CARD: "Card" } as const;
/** Review 5B-M1 M1: how far back a payment date may go (a counter that was offline for a few days). */
export const BACKDATE_DAYS = 7;

export async function searchForCollection(ctx: AuthContext, q: string) {
  authorizeFeeWrite(ctx, "fee.collect");
  return searchStudentsAnySession(prisma, q);
}

type Db = Tx | typeof prisma;

/** Open invoices of a student (all sessions) with outstanding items and the live late fee as of `asOf`. */
async function openInvoicesOf(db: Db, studentId: string, asOf: string, onlyIds?: string[]) {
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

/** The counter screen: student, open invoices (oldest first) with live late fees, total due today, today's receipts. */
export async function getCounterView(ctx: AuthContext, studentId: string) {
  authorizeFeeWrite(ctx, "fee.collect");
  const who = await latestEnrollment(prisma, studentId);
  if (!who) throw new NotFoundError("Student not found.");
  const settings = await readFeeSettingsTx(prisma as unknown as Tx);
  const today = todayInTimeZone(settings.timezone ?? undefined);
  const [open, todays] = await Promise.all([
    openInvoicesOf(prisma, studentId, today),
    // Review L7: today's receipts for this student, so a second tab collecting the same money stands out.
    prisma.feePayment.findMany({
      where: { studentId, createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, receiptNo: true, amount: true, method: true, status: true, collectedBy: { select: { displayName: true } } },
    }),
  ]);
  const due = sumMoney(open.flatMap((i) => [i.balance, i.lateFee]));
  return {
    student: { studentId, studentCode: who.studentCode, fullName: who.fullName, className: who.className, sectionCode: who.sectionCode },
    today,
    earliestDate: iso(new Date(day(today).getTime() - BACKDATE_DAYS * 86_400_000)),
    receiptFormatSet: settings.feeReceipt !== null,
    canWaiveLateFee: holdsAll(ctx, "fee.concession.manage"),
    invoices: open,
    totalDue: moneyString(due),
    recentReceipts: todays.map((p) => ({ id: p.id, receiptNo: p.receiptNo, amount: moneyString(p.amount.toString()), method: METHOD_LABEL[p.method], cancelled: p.status === "CANCELLED", collectedBy: p.collectedBy?.displayName ?? null })),
  };
}

/** The system LATE_FEE head, created on first use (FC2; the code is reserved in setup — review L5). */
async function lateFeeCategory(tx: Tx) {
  return tx.feeCategory.upsert({ where: { code: "LATE_FEE" }, update: {}, create: { code: "LATE_FEE", name: "Late fee", nameKey: "late fee (system)", kind: "LATE_FEE", appliesTo: "ALL" }, select: { id: true, name: true } });
}

const REF_INDEXES = [
  { index: "fee_payment_live_utr_key", fields: ["transactionRef"] },
  { index: "fee_payment_live_cheque_key", fields: ["transactionRef", "bankName", "instrumentDate"] },
  { index: "fee_payment_live_card_key", fields: ["transactionRef"] },
];

function mapErrors(e: unknown): never {
  if (isUniqueViolation(e, "idempotencyKey")) throw new ConflictError("This payment was already submitted. Reload the page to see the receipt.");
  if (isUniqueViolation(e, "receiptNo")) throw new ConflictError("A receipt number made with the current format already exists. Ask the school administrator to change the receipt number format.");
  // Review L5: name only the reference indexes; any other clash is "busy, try again".
  if (REF_INDEXES.some((idx) => isUniqueViolationOf(e, idx))) throw new ConflictError("This reference is already used on another receipt. Check the UPI / bank / cheque / card reference.");
  if (isUniqueViolation(e) || isTransactionBusy(e)) throw new ServiceBusyError();
  if (e instanceof AllocationError) throw new ValidationError(e.message, [{ path: "amount", message: e.message }]);
  throw e;
}

async function replayOf(db: Db, ctx: AuthContext, input: CollectInput) {
  const prior = await db.feePayment.findUnique({ where: { idempotencyKey: input.idempotencyKey }, select: { id: true, receiptNo: true, studentId: true, amount: true, collectedById: true, status: true } });
  if (!prior) return null;
  if (prior.studentId === input.studentId && prior.collectedById === ctx.userId && moneyString(prior.amount.toString()) === moneyString(input.amount)) {
    return { id: prior.id, receiptNo: prior.receiptNo, replay: true, cancelled: prior.status === "CANCELLED" };
  }
  throw new ConflictError("This form was already used for another payment. Reload the page and try again.");
}

/** Collect a payment at the counter and issue its receipt in ONE transaction. */
export async function collectPayment(ctx: AuthContext, input: CollectInput) {
  authorizeFeeWrite(ctx, "fee.collect");
  if (input.waiveLateFeeInvoiceIds.length > 0 && !holdsAll(ctx, "fee.concession.manage")) throw new ForbiddenError("You can't waive late fees.");
  const ref = input.method === "CASH" ? null : input.transactionRef ? normalizeReferenceFor(input.method, input.transactionRef) : null;
  if (input.method !== "CASH" && !ref) throw new ValidationError("Enter a valid reference (letters and digits; cheques may also use / - _ .).", [{ path: "transactionRef", message: "Invalid reference." }]);
  const bank = input.method === "CHEQUE" && input.bankName ? normalizeBankName(input.bankName) : null;
  if (input.method === "CHEQUE" && !bank) throw new ValidationError("Enter the bank name.", [{ path: "bankName", message: "Invalid bank name." }]);
  const instrumentDate = input.method === "CHEQUE" ? input.instrumentDate : null; // review L4: only cheques have one
  const school = await getSchoolName(); // read before the transaction (cached public profile)
  try {
    return await prisma.$transaction(
      async (tx) => {
        const early = await replayOf(tx, ctx, input);
        if (early) return early;
        await lockFeeStudent(tx, input.studentId);
        // Review L1: check the key again under the lock (a concurrent same-key submit has committed by now).
        const again = await replayOf(tx, ctx, input);
        if (again) return again;
        const settings = await readFeeSettingsTx(tx);
        if (!settings.feeReceipt) throw new ConflictError("Set the receipt number format first (Fees → Fee heads).");
        const today = todayInTimeZone(settings.timezone ?? undefined);
        if (input.paidOn > today) throw new ValidationError("The payment date can't be in the future.", [{ path: "paidOn", message: "Future date." }]);
        const backdated = daysBetween(today, input.paidOn);
        if (backdated > BACKDATE_DAYS) throw new ValidationError(`The payment date can be at most ${BACKDATE_DAYS} days ago.`, [{ path: "paidOn", message: "Too far back." }]);
        const who = await latestEnrollment(tx, input.studentId);
        if (!who) throw new NotFoundError("Student not found.");
        // Lock the student's open invoices; review L2: read ONLY the rows locked.
        const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_invoice WHERE student_id = ${input.studentId} AND deleted_at IS NULL AND status IN ('ISSUED', 'PARTIAL') ORDER BY id LIMIT 100 FOR UPDATE`;
        if (locked.length === 0) throw new ConflictError("This student has nothing to pay.");
        // Review M1: the late fee as of TODAY, whatever the payment date.
        const open = await openInvoicesOf(tx, input.studentId, today, locked.map((l) => l.id));
        if (open.length === 0) throw new ConflictError("This student has nothing to pay.");
        const known = new Set(open.map((o) => o.id));
        for (const id of [...input.invoiceIds, ...input.waiveLateFeeInvoiceIds]) if (!known.has(id)) throw new ConflictError("An invoice you chose is no longer open. Reload the page.");
        const waive = new Set(input.waiveLateFeeInvoiceIds);
        const VIRTUAL = "late:";
        const forAllocation: OpenInvoice[] = open.map((o) => ({
          id: o.id,
          invoiceNo: o.invoiceNo,
          dueOn: o.dueOn,
          items: [
            ...o.items.map((it) => ({ id: it.id, kind: it.kind, sortOrder: it.sortOrder, outstanding: it.outstanding })),
            ...(toMoney(o.lateFee).gt(0) && !waive.has(o.id) ? [{ id: `${VIRTUAL}${o.id}`, kind: "LATE_FEE" as const, sortOrder: 9999, outstanding: o.lateFee }] : []),
          ],
        }));
        const allocations = allocatePayment(input.amount, forAllocation, input.invoiceIds.length ? input.invoiceIds : undefined);
        const touched = new Set(allocations.map((a) => a.invoiceId));
        // Review M3: a waiver only on invoices this payment pays.
        for (const id of waive) if (!touched.has(id)) throw new ValidationError("A late fee can only be waived on an invoice this payment pays.", [{ path: "waiveLateFee", message: "Not paid by this payment." }]);
        // FC7: freeze the late fee on every invoice this payment touches.
        const lateItemId = new Map<string, string>();
        let lateCat: { id: string; name: string } | null = null;
        for (const o of open) {
          if (!touched.has(o.id) || !toMoney(o.lateFee).gt(0)) continue;
          lateCat ??= await lateFeeCategory(tx);
          if (waive.has(o.id)) {
            // Review M2: the waiver stays on the invoice — zero line, waived amount and reason in its text (fee staff only).
            const text = `Late fee ₹${o.lateFee} waived: ${input.waiveReason ?? ""}`.slice(0, 120).trim();
            await tx.feeInvoiceItem.create({ data: { invoiceId: o.id, categoryId: lateCat.id, kind: "LATE_FEE", description: text, amount: "0.00", sortOrder: 9999 } });
            continue;
          }
          const item = await tx.feeInvoiceItem.create({ data: { invoiceId: o.id, categoryId: lateCat.id, kind: "LATE_FEE", description: lateCat.name, amount: o.lateFee, sortOrder: 9999 }, select: { id: true } });
          lateItemId.set(o.id, item.id);
          await tx.feeInvoice.update({ where: { id: o.id }, data: { lateFee: { increment: o.lateFee }, total: { increment: o.lateFee }, version: { increment: 1 } } });
        }
        const resolved = allocations.map((a) => ({ ...a, itemId: a.itemId.startsWith(VIRTUAL) ? lateItemId.get(a.invoiceId)! : a.itemId }));
        // Receipt number LAST (its row lock serializes collectors; a rollback consumes no number). Review M1: year of TODAY.
        const tokens = { code: settings.shortCode ?? undefined, year: Number(today.slice(0, 4)) };
        let receiptNo: string;
        try {
          receiptNo = formatSequence(settings.feeReceipt, await nextSequence(tx, sequenceKey("fee_receipt", settings.feeReceipt, tokens)), tokens);
        } catch (e) {
          if (e instanceof Error && /^Missing value for \{/.test(e.message)) throw new ConflictError("The receipt number format needs the school short code. Set it in Settings.");
          throw e;
        }
        if (receiptNo.length > 40) throw new ConflictError("Receipt numbers made with the current format are longer than 40 characters.");
        const byInvoice = new Map(open.map((o) => [o.id, o]));
        const snapshot = {
          v: 1,
          school,
          receiptNo,
          paidOn: input.paidOn,
          student: { name: who.fullName, studentCode: who.studentCode, className: who.className, sectionCode: who.sectionCode },
          method: METHOD_LABEL[input.method],
          reference: ref,
          bankName: bank,
          instrumentDate,
          lines: resolved.map((a) => {
            const inv = byInvoice.get(a.invoiceId)!;
            const item = inv.items.find((it) => it.id === a.itemId);
            return { invoiceNo: inv.invoiceNo, session: inv.sessionName, installment: inv.installmentName, description: item ? item.description : "Late fee", amount: a.amount };
          }),
          amount: moneyString(input.amount),
          amountInWords: amountInWordsIndian(input.amount),
          collectedBy: ctx.displayName,
        };
        const payment = await tx.feePayment.create({
          data: {
            receiptNo,
            studentId: input.studentId,
            amount: input.amount,
            method: input.method,
            transactionRef: ref,
            instrumentDate: instrumentDate ? day(instrumentDate) : null,
            bankName: bank,
            paidOn: day(input.paidOn),
            idempotencyKey: input.idempotencyKey,
            collectedById: ctx.userId,
            receiptSnapshot: snapshot,
          },
          select: { id: true },
        });
        await tx.feePaymentAllocation.createMany({ data: resolved.map((a) => ({ paymentId: payment.id, invoiceItemId: a.itemId, invoiceId: a.invoiceId, studentId: input.studentId, amount: a.amount })) });
        for (const a of resolved) await tx.feeInvoiceItem.update({ where: { id: a.itemId }, data: { paidAmount: { increment: a.amount } } });
        for (const invoiceId of touched) {
          const inv = await tx.feeInvoice.findUniqueOrThrow({ where: { id: invoiceId }, select: { total: true, paidAmount: true } });
          const paid = inv.paidAmount.plus(sumMoney(resolved.filter((a) => a.invoiceId === invoiceId).map((a) => a.amount)).toString());
          await tx.feeInvoice.update({ where: { id: invoiceId }, data: { paidAmount: paid.toString(), status: paid.gte(inv.total) ? "PAID" : "PARTIAL", version: { increment: 1 } } });
        }
        await audit(tx, actorOf(ctx), { action: "fee_payment.collect", entityType: "FeePayment", entityId: payment.id, after: { receiptNo, method: input.method, paidOn: input.paidOn, invoices: touched.size, ...(backdated > 0 ? { backdatedDays: backdated } : {}) } });
        if (waive.size > 0) await audit(tx, actorOf(ctx), { action: "fee_late_fee.waive", entityType: "FeePayment", entityId: payment.id, after: { invoiceIds: [...waive] } });
        return { id: payment.id, receiptNo, replay: false, cancelled: false };
      },
      { timeout: 20_000 },
    );
  } catch (e) {
    mapErrors(e);
  }
}
