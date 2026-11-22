import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5B-M1 counter collection against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * Oldest-first allocation, PARTIAL → PAID, late fee frozen once, waiver kept, idempotent replay (same collector only),
 * one UTR space for UPI + bank transfer, over-payment refused, concurrent collections get distinct consecutive numbers,
 * the database refuses edits to issued receipts (trigger), audit without amounts.
 * Needs migrations 20261124000000 + 20261125000000 and the Phase 5 catalog on Test.
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
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee collection (integration)", () => {
  const run = `fp${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, accountant2: Ctx;
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

  it("the counter shows oldest first with today's late fee; a partial payment goes to the oldest invoice and freezes its late fee", async () => {
    const view = await m.getCounterView(accountant, studentId);
    expect(view.invoices.map((i) => i.installmentName)).toEqual(["Q1", "Q2"]);
    expect(view.invoices[0].lateFee).toBe("100.00");
    expect(view.totalDue).toBe("6100.00");
    const r = await m.collectPayment(accountant, cash("1000.00"));
    expect(r!.replay).toBe(false);
    const after = await m.getCounterView(accountant, studentId);
    expect(after.invoices[0]).toMatchObject({ balance: "2100.00", lateFee: "0.00" }); // 3000 + 100 frozen − 1000
    expect(after.totalDue).toBe("5100.00");
  });

  it("review 5B-M1: no backdating past 7 days; the late fee is frozen once; a waiver only on an invoice the payment pays, kept with its reason", async () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await expect(m.collectPayment(accountant, cash("10.00", { paidOn: old }))).rejects.toThrow(/at most 7 days/);
    // Q1 already carries its frozen late fee: a second payment adds no new late fee.
    const before = await m.getCounterView(accountant, studentId);
    expect(before.invoices[0].lateFee).toBe("0.00");
    // Q2 isn't overdue, so it has no late fee to waive; waiving on Q1 (already frozen) has nothing to waive either —
    // a waiver on an invoice this payment doesn't pay is refused.
    const q2inv = before.invoices.find((i) => i.installmentName === "Q2")!;
    await expect(m.collectPayment(accountant, cash("10.00", { invoiceIds: [before.invoices[0].id], waiveLateFeeInvoiceIds: [q2inv.id], waiveReason: "Hospitalised" }))).rejects.toThrow(/only be waived on an invoice this payment pays/);
  });

  it("concurrent submits with the SAME key give one receipt", async () => {
    const k = key();
    const results = await Promise.allSettled([m.collectPayment(accountant, cash("20.00", { idempotencyKey: k })), m.collectPayment(accountant, cash("20.00", { idempotencyKey: k }))]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof m.collectPayment>>> => r.status === "fulfilled").map((r) => r.value!.receiptNo);
    expect(new Set(ok).size).toBe(1);
    expect(await m.prisma.feePayment.count({ where: { idempotencyKey: k } })).toBe(1);
  });

  it("idempotent replay for the same collector; another collector's replay is refused; over-payment refused", async () => {
    const k = key();
    const a = await m.collectPayment(accountant, cash("100.00", { idempotencyKey: k }));
    const b = await m.collectPayment(accountant, cash("100.00", { idempotencyKey: k }));
    expect(b).toMatchObject({ receiptNo: a!.receiptNo, replay: true });
    await expect(m.collectPayment(accountant2, cash("100.00", { idempotencyKey: k }))).rejects.toThrow(/already used/);
    await expect(m.collectPayment(accountant, cash("999999.00"))).rejects.toThrow(/more than what is due/);
  });

  it("one UTR space for UPI and bank transfer (review 5A M4)", async () => {
    await m.collectPayment(accountant, { ...cash("50.00"), method: "UPI", transactionRef: `utr${tag}0001` });
    await expect(m.collectPayment(accountant, { ...cash("50.00"), method: "BANK_TRANSFER", transactionRef: `UTR${tag}0001` })).rejects.toThrow(/already used on another receipt/);
  });

  it("concurrent collections get distinct, consecutive receipt numbers", async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => m.collectPayment(accountant, cash("10.00"))));
    const nos = results.filter((x): x is PromiseFulfilledResult<Awaited<ReturnType<typeof m.collectPayment>>> => x.status === "fulfilled").map((x) => Number(x.value!.receiptNo.split("/")[1]));
    expect(nos.length).toBeGreaterThan(0);
    expect(new Set(nos).size).toBe(nos.length);
    const sorted = [...nos].sort((p, q) => p - q);
    expect(sorted[sorted.length - 1] - sorted[0]).toBe(nos.length - 1);
  });

  it("the database refuses to rewrite or delete an issued receipt; audit rows hold no amounts", async () => {
    const p = await m.prisma.feePayment.findFirstOrThrow({ where: { studentId }, select: { id: true } });
    await expect(m.prisma.feePayment.update({ where: { id: p.id }, data: { amount: "1.00" } })).rejects.toThrow();
    await expect(m.prisma.feePayment.delete({ where: { id: p.id } })).rejects.toThrow();
    const rows = await m.prisma.auditLog.findMany({ where: { action: "fee_payment.collect", actorId: accountant.userId }, select: { after: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/"amount"|1000\.00|UTR/);
  });
});
