import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5C-M2 reconciliation against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * A simulated term (cash / UPI / cheque, a partial, a cancelled receipt) reconciles; a damaged line and a used-up
 * receipt number are caught. The Test branch is shared: assertions look at this run's number series (R<tag>/, I<tag>/).
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
  ...(await import("@/modules/fees/reconciliation.service")),
  ...(await import("@/lib/sequence")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee reconciliation (integration)", () => {
  const run = `fz${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, accountant2: Ctx, principal: Ctx, teacher: Ctx;
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
    teacher = await login((await user("tch", "CLASS_TEACHER")).id);
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

  const mine = (samples: string[]) => samples.filter((s) => s.includes(`R${tag}/`) || s.includes(`I${tag}/`));
  const byKey = (r: Awaited<ReturnType<typeof m.runReconciliation>>, k: string) => r.checks.find((c) => c.key === k)!;

  it("a simulated term reconciles: collections, a partial, a cancellation, a cancelled and re-issued invoice", async () => {
    await m.collectPayment(accountant, cash("1000.00"));
    await m.collectPayment(accountant2, { ...cash("2100.00"), method: "UPI", transactionRef: `UTR${tag}9001` }); // Q1 paid with its late fee
    const c = (await m.collectPayment(accountant, cash("500.00")))!; // goes to Q2
    await m.cancelReceipt(accountant2, { id: c.id, version: 1, reason: "Synthetic bounced" });
    await m.collectPayment(accountant, { ...cash("250.00"), method: "CHEQUE", transactionRef: `CHQ${tag}1`, bankName: "Synthetic Bank", instrumentDate: today });
    const q2inv = await m.prisma.feeInvoice.findFirstOrThrow({ where: { academicSessionId: sessionId, installmentId: q2 }, select: { status: true } });
    expect(q2inv.status).toBe("PARTIAL");
    const r = await m.runReconciliation(principal);
    for (const k of ["payment-allocations", "item-paid", "invoice-paid", "invoice-totals"]) expect(mine(byKey(r, k).samples), k).toEqual([]);
    // Other suites on the shared Test branch delete their own rows (gaps in THEIR series); ours must have none.
    expect(mine(byKey(r, "receipt-gaps").samples)).toEqual([]);
    expect(mine(byKey(r, "invoice-gaps").samples)).toEqual([]);
    const audit = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "fee_reconciliation.run", actorId: principal.userId }, orderBy: { id: "desc" }, select: { after: true } });
    expect(audit.after).toHaveProperty("problems");
  });

  it("a line whose paid amount disagrees with its payments is caught (and the invoice above it)", async () => {
    const item = await m.prisma.feeInvoiceItem.findFirstOrThrow({ where: { invoice: { academicSessionId: sessionId, installmentId: q2 }, kind: "STRUCTURE" }, select: { id: true, paidAmount: true, invoice: { select: { invoiceNo: true } } } });
    await m.prisma.feeInvoiceItem.update({ where: { id: item.id }, data: { paidAmount: { increment: 1 } } }); // simulated damage
    try {
      const r = await m.runReconciliation(principal);
      expect(byKey(r, "item-paid").samples).toContain(item.invoice.invoiceNo);
      expect(byKey(r, "invoice-paid").samples).toContain(item.invoice.invoiceNo);
      expect(byKey(r, "item-paid").problems).toBeGreaterThan(0);
    } finally {
      await m.prisma.feeInvoiceItem.update({ where: { id: item.id }, data: { paidAmount: item.paidAmount } });
    }
  });

  it("a receipt number used up without a receipt shows as a gap in our series", async () => {
    const tokens = { code: undefined, year: Number(today.slice(0, 4)) };
    await m.prisma.$transaction(async (tx) => {
      await m.nextSequence(tx, m.sequenceKey("fee_receipt", `R${tag}/{SEQ:5}`, tokens)); // consumed, no receipt
    });
    const r1 = (await m.collectPayment(accountant, cash("10.00")))!;
    const r = await m.runReconciliation(principal);
    const missing = Number(r1.receiptNo.split("/")[1]) - 1;
    expect(byKey(r, "receipt-gaps").samples).toContain(`R${tag}/${String(missing).padStart(5, "0")}`);
  });

  it("only fee.report holders may run it", async () => {
    await expect(m.runReconciliation(teacher)).rejects.toBeInstanceOf(m.ForbiddenError);
  });
});
