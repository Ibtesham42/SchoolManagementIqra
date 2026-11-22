import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5B-M3 receipt cancellation against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * Reversal restores balances (PAID -> ISSUED, PAID -> PARTIAL), the late-fee freeze / waiver is undone when no live
 * payment remains (review M1), canceller != collector (service
 * and database CHECK), stale version / second cancel refused, concurrent cancels -> one, the reference is free again,
 * a replay of a cancelled receipt's key says so, the reason is hidden from readers without fee.refund, audit has no
 * amount / reason. Needs migrations 20261124000000 + 20261125000000 and the Phase 5 catalog on Test.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/format")),
  ...(await import("@/modules/fees/setup.service")),
  ...(await import("@/modules/fees/invoices.service")),
  ...(await import("@/modules/fees/collection.service")),
  ...(await import("@/modules/fees/receipts.service")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("receipt cancellation (integration)", () => {
  const run = `fr${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, accountant2: Ctx, principal: Ctx, schoolAdmin: Ctx;
  let sessionId: string, classId: string, studentId: string, q1: string, q2: string, tui: string;
  let today: string;
  let formatsBefore: { feeReceipt: string | null; feeInvoice: string | null } = { feeReceipt: null, feeInvoice: null };
  const key = () => crypto.randomUUID();
  const cash = (amount: string, extra: Record<string, unknown> = {}) => ({ studentId, amount, method: "CASH" as const, transactionRef: null, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: key(), ...extra });

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    accountant2 = await login((await user("acc2", "ACCOUNTANT")).id);
    principal = await login((await user("pri", "PRINCIPAL")).id);
    schoolAdmin = await login((await user("sa", "SCHOOL_ADMIN")).id);
    formatsBefore = await m.getFeeNumberFormats(accountant);
    await m.updateFeeNumberFormats(accountant, { feeReceipt: `R${tag}/{SEQ:5}`, feeInvoice: `I${tag}/{SEQ:5}` });
    today = m.todayInTimeZone();
    const start = new Date(d(today).getTime() - 90 * 86_400_000);
    const end = new Date(d(today).getTime() + 200 * 86_400_000);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-now`, startDate: start, endDate: end, status: "ACTIVE" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C4`, name: `${run} four`, nameKey: `${run} four`, numericLevel: 4 } })).id;
    const sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId, name: "A", nameKey: "a", code: `${tag}C4-A`, capacity: 40 } })).id;
    const s = await m.prisma.student.create({
      data: { studentCode: `${tag}-STU-1`, admissionNo: `${tag}-ADM-1`, firstName: "Synthetic", fullName: "Synthetic Payer", fullNameNormalized: "synthetic payer", dob: d("2090-06-01"), gender: "OTHER", admissionDate: start, admittedSessionId: sessionId },
    });
    studentId = s.id;
    await m.prisma.studentEnrollment.create({ data: { studentId, academicSessionId: sessionId, sectionId, enrolledOn: start } });
    tui = (await m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Tuition`, kind: "REGULAR", appliesTo: "ALL" }))!.id;
    q1 = (await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Q1", dueOn: iso(new Date(d(today).getTime() - 30 * 86_400_000)), sortOrder: 0 }))!.id;
    q2 = (await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Q2", dueOn: iso(new Date(d(today).getTime() + 60 * 86_400_000)), sortOrder: 1 }))!.id;
    await m.createFeeStructure(accountant, { academicSessionId: sessionId, classId, name: "Four", items: [{ categoryId: tui, installmentId: q1, amount: "3000.00" }, { categoryId: tui, installmentId: q2, amount: "3000.00" }] });
    await m.setLateFeeRule(accountant, { academicSessionId: sessionId, graceDays: 0, calc: "FLAT", value: "100", cap: null });
    for (const installmentId of [q1, q2]) await m.issueInvoices(accountant, { academicSessionId: sessionId, classId, installmentId });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    // Receipts and allocations are append-only by trigger (review 5A M1); test data is removed with the trigger
    // temporarily disabled in this transaction only.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE fee_payment_allocation DISABLE TRIGGER fee_payment_allocation_immutable`;
      await tx.$executeRaw`ALTER TABLE fee_payment DISABLE TRIGGER fee_payment_immutable`;
      await tx.feePaymentAllocation.deleteMany({ where: { studentId } });
      await tx.feePayment.deleteMany({ where: { studentId } });
      await tx.$executeRaw`ALTER TABLE fee_payment ENABLE TRIGGER fee_payment_immutable`;
      await tx.$executeRaw`ALTER TABLE fee_payment_allocation ENABLE TRIGGER fee_payment_allocation_immutable`;
    });
    await prisma.feeInvoiceItem.deleteMany({ where: { invoice: { academicSessionId: sessionId } } });
    await prisma.feeInvoice.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.lateFeeRule.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeStructure.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeInstallment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeCategory.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    const s = await prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { idFormats: true } });
    if (s) {
      const f = { ...((s.idFormats ?? {}) as Record<string, unknown>) };
      for (const k of ["feeReceipt", "feeInvoice"] as const) {
        if (formatsBefore[k]) f[k] = formatsBefore[k];
        else delete f[k];
      }
      await prisma.schoolSetting.update({ where: { id: "default" }, data: { idFormats: f as object } });
    }
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  const counter = () => m.getCounterView(accountant, studentId);
  const invoiceRow = (id: string) => m.prisma.feeInvoice.findUniqueOrThrow({ where: { id }, select: { status: true, paidAmount: true, lateFee: true, total: true } });
  const version = async (id: string) => (await m.prisma.feePayment.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;

  it("cancelling a receipt that paid Q1 in full puts Q1 back to ISSUED and undoes its frozen late fee (review M1)", async () => {
    const before = await counter();
    expect(before.totalDue).toBe("6100.00");
    const q1inv = before.invoices[0].id;
    const r = (await m.collectPayment(accountant, cash("3100.00")))!; // 3000 + 100 late fee → Q1 PAID
    expect(await invoiceRow(q1inv)).toMatchObject({ status: "PAID" });
    const out = await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Cheque bounced" });
    expect(out).toEqual({ receiptNo: r.receiptNo, invoices: 1 });
    const inv = await invoiceRow(q1inv);
    expect(inv.status).toBe("ISSUED");
    expect(inv.paidAmount.toFixed(2)).toBe("0.00");
    expect(inv.lateFee.toFixed(2)).toBe("0.00"); // no live payment left: the freeze is undone
    expect(inv.total.toFixed(2)).toBe("3000.00");
    const items = await m.prisma.feeInvoiceItem.findMany({ where: { invoiceId: q1inv }, select: { kind: true, amount: true, paidAmount: true, description: true } });
    expect(items.every((i) => i.paidAmount.isZero())).toBe(true);
    // The late line was paid (allocation history), so it is voided to zero rather than removed.
    expect(items.filter((i) => i.kind === "LATE_FEE").map((i) => [i.amount.toFixed(2), i.description])).toEqual([["0.00", m.VOID_LATE_FEE]]);
    const allocs = await m.prisma.feePaymentAllocation.findMany({ where: { paymentId: r.id }, select: { reversedAt: true } });
    expect(allocs.length).toBeGreaterThan(0);
    expect(allocs.every((a) => a.reversedAt !== null)).toBe(true);
    const after = await counter();
    expect(after.invoices[0]).toMatchObject({ id: q1inv, balance: "3000.00", lateFee: "100.00" }); // worked out again
    expect(after.totalDue).toBe("6100.00");
    const p = await m.prisma.feePayment.findUniqueOrThrow({ where: { id: r.id }, select: { status: true, receiptNo: true, cancelledById: true } });
    expect(p).toMatchObject({ status: "CANCELLED", receiptNo: r.receiptNo, cancelledById: principal.userId });
  });

  it("waive-then-cancel doesn't waive for good: the waiver line goes with the cancelled payment (review M1)", async () => {
    const before = await counter();
    const q1inv = before.invoices[0].id;
    expect(before.invoices[0].lateFee).toBe("100.00");
    const r = (await m.collectPayment(accountant, cash("10.00", { invoiceIds: [q1inv], waiveLateFeeInvoiceIds: [q1inv], waiveReason: "Synthetic hardship" })))!;
    expect((await counter()).invoices[0].lateFee).toBe("0.00");
    await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Cheque bounced" });
    expect((await counter()).invoices[0]).toMatchObject({ balance: "3000.00", lateFee: "100.00" });
    expect(await m.prisma.feeInvoiceItem.count({ where: { invoiceId: q1inv, kind: "LATE_FEE", description: { startsWith: "Late fee ₹" } } })).toBe(0);
    const row = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "fee_payment.cancel", entityId: r.id }, select: { after: true } });
    expect(row.after).toMatchObject({ invoiceIds: [q1inv], lateFeeUnfrozen: [q1inv] });
  });

  it("cancelling one of two payments leaves the invoice PARTIAL with its late fee; cancelling the last undoes it", async () => {
    const a = (await m.collectPayment(accountant, cash("1000.00")))!;
    const b = (await m.collectPayment(accountant, cash("500.00")))!;
    const q1inv = (await m.prisma.feePaymentAllocation.findFirstOrThrow({ where: { paymentId: a.id }, select: { invoiceId: true } })).invoiceId;
    expect(await invoiceRow(q1inv)).toMatchObject({ status: "PARTIAL" });
    await m.cancelReceipt(accountant2, { id: b.id, version: await version(b.id), reason: "Entered twice" });
    const inv = await invoiceRow(q1inv);
    expect(inv.status).toBe("PARTIAL");
    expect(inv.paidAmount.toFixed(2)).toBe("1000.00");
    expect(inv.lateFee.toFixed(2)).toBe("100.00"); // the live payment still justifies the freeze
    await m.cancelReceipt(accountant2, { id: a.id, version: await version(a.id), reason: "Wrong student" });
    const last = await invoiceRow(q1inv);
    expect(last.status).toBe("ISSUED");
    expect(last.lateFee.toFixed(2)).toBe("0.00");
    expect((await counter()).invoices[0].lateFee).toBe("100.00");
  });

  it("the collector can't cancel their own receipt — in the service and in the database", async () => {
    const r = (await m.collectPayment(accountant, cash("10.00")))!;
    await expect(m.cancelReceipt(accountant, { id: r.id, version: await version(r.id), reason: "My own mistake" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.prisma.feePayment.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelledById: accountant.userId, cancelReason: "bypass" } })).rejects.toThrow();
    expect((await m.prisma.feePayment.findUniqueOrThrow({ where: { id: r.id }, select: { status: true } })).status).toBe("SUCCESS");
    await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Clean up test" });
  });

  it("a stale version and a second cancel are refused; concurrent cancels give one cancellation", async () => {
    const r = (await m.collectPayment(accountant, cash("10.00")))!;
    const v = await version(r.id);
    await expect(m.cancelReceipt(principal, { id: r.id, version: v + 1, reason: "Stale form" })).rejects.toBeInstanceOf(m.ConflictError);
    const results = await Promise.allSettled([m.cancelReceipt(principal, { id: r.id, version: v, reason: "Tab one" }), m.cancelReceipt(accountant2, { id: r.id, version: v, reason: "Tab two" })]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await m.prisma.auditLog.count({ where: { action: "fee_payment.cancel", entityId: r.id } })).toBe(1);
    await expect(m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Again" })).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("a UPI reference is free again after cancellation; a replay of the cancelled form says so", async () => {
    const ref = `UTR${tag}7788`;
    const k = key();
    const r = (await m.collectPayment(accountant, { ...cash("25.00", { idempotencyKey: k }), method: "UPI", transactionRef: ref }))!;
    await expect(m.collectPayment(accountant, { ...cash("25.00"), method: "UPI", transactionRef: ref })).rejects.toThrow(/already used on another receipt/);
    await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Payment failed at the bank" });
    expect(await m.collectPayment(accountant, { ...cash("25.00", { idempotencyKey: k }), method: "UPI", transactionRef: ref })).toMatchObject({ receiptNo: r.receiptNo, replay: true, cancelled: true });
    const again = (await m.collectPayment(accountant, { ...cash("25.00"), method: "UPI", transactionRef: ref }))!;
    expect(again.replay).toBe(false);
  });

  it("the reason is shown to fee.refund holders only; lookup by number; audit without amount or reason", async () => {
    const r = (await m.collectPayment(accountant, cash("10.00")))!;
    await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Synthetic private reason" });
    expect((await m.getReceipt(accountant2, r.id)).cancelReason).toBe("Synthetic private reason");
    const forAdmin = await m.getReceipt(schoolAdmin, r.id); // fee.read without fee.refund
    expect(forAdmin.cancelled).toBe(true);
    expect(forAdmin.cancelReason).toBeNull();
    expect(forAdmin.canCancel).toBe(false);
    expect(await m.findReceiptId(principal, { receiptNo: r.receiptNo.toLowerCase() })).toBe(r.id);
    expect(await m.findReceiptId(principal, { receiptNo: "NO-SUCH-RECEIPT" })).toBeNull();
    const list = await m.listReceipts(principal, 1);
    expect(list.receipts.some((x) => x.id === r.id && x.cancelled)).toBe(true);
    const rows = await m.prisma.auditLog.findMany({ where: { action: "fee_payment.cancel", entityId: r.id }, select: { after: true, before: true } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toMatch(/"amount"|10\.00|private reason/);
  });

  it("review M2: an Accountant cancels only today's receipts; a closed session's receipt needs a Super Admin", async () => {
    const r = (await m.collectPayment(accountant, cash("10.00")))!;
    // Make the receipt yesterday's: created_at is immutable by trigger, so the test lifts it in this transaction only.
    await m.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE fee_payment DISABLE TRIGGER fee_payment_immutable`;
      await tx.$executeRaw`UPDATE fee_payment SET created_at = created_at - interval '1 day' WHERE id = ${r.id}`;
      await tx.$executeRaw`ALTER TABLE fee_payment ENABLE TRIGGER fee_payment_immutable`;
    });
    await expect(m.cancelReceipt(accountant2, { id: r.id, version: await version(r.id), reason: "Entered twice" })).rejects.toThrow(/before today/);
    expect((await m.getReceipt(accountant2, r.id)).cancelBlockedReason).toMatch(/before today/);
    await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "CLOSED" } });
    try {
      await expect(m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Entered twice" })).rejects.toThrow(/closed academic session/);
    } finally {
      await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "ACTIVE" } });
    }
    await m.cancelReceipt(principal, { id: r.id, version: await version(r.id), reason: "Entered twice" });
  });

  it("5B-M2: collector prints count (original, then DUPLICATE) without bumping the version; others get an uncounted office copy", async () => {
    const r = (await m.collectPayment(accountant, cash("10.00")))!;
    const v = await version(r.id);
    const office = await m.renderReceiptPdf(principal, r.id); // fee.refund without fee.collect: not counted (review L2)
    expect(office.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(office.fileName).toMatch(/^fee-receipt-[A-Za-z0-9-]+\.pdf$/);
    expect((await m.prisma.feePayment.findUniqueOrThrow({ where: { id: r.id }, select: { printCount: true } })).printCount).toBe(0);
    await m.renderReceiptPdf(accountant, r.id);
    await m.renderReceiptPdf(accountant2, r.id);
    const row = await m.prisma.feePayment.findUniqueOrThrow({ where: { id: r.id }, select: { printCount: true, version: true } });
    expect(row).toEqual({ printCount: 2, version: v });
    expect((await m.getReceipt(accountant, r.id)).printCount).toBe(2);
    const audits = await m.prisma.auditLog.findMany({ where: { action: "fee_payment.print", entityId: r.id }, orderBy: { id: "asc" }, select: { after: true } });
    expect(audits.map((a) => (a.after as { copy: number | string }).copy)).toEqual(["view", 1, 2]);
    await expect(m.prisma.feePayment.update({ where: { id: r.id }, data: { printCount: 0 } })).rejects.toThrow(); // only grows
    await m.cancelReceipt(principal, { id: r.id, version: v, reason: "Clean up test" }); // a print didn't make the form stale
  });

  it("FC8 invariant: live allocations equal every SUCCESS payment; item paid amounts equal their live allocations", async () => {
    const pays = await m.prisma.feePayment.findMany({ where: { studentId }, select: { amount: true, status: true, allocations: { where: { reversedAt: null }, select: { amount: true } } } });
    for (const p of pays) {
      const live = p.allocations.reduce((s, a) => s + Number(a.amount), 0);
      expect(live.toFixed(2)).toBe(p.status === "SUCCESS" ? p.amount.toFixed(2) : "0.00");
    }
    const items = await m.prisma.feeInvoiceItem.findMany({ where: { invoice: { studentId } }, select: { paidAmount: true, allocations: { where: { reversedAt: null }, select: { amount: true } } } });
    for (const it of items) expect(it.allocations.reduce((s, a) => s + Number(a.amount), 0).toFixed(2)).toBe(it.paidAmount.toFixed(2));
  });
});
