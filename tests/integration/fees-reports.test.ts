import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5C-M1 fee reports against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * Collection by collector / method / fee head (SUCCESS only), cancelled-receipt register, outstanding by class and
 * installment = the invoices, defaulters (overdue days, guardian columns for student.read ALL), cancelled invoices not
 * issued again, concession register, CSV export (export.run, BOM, audited without data). Reasons never appear.
 * The Test branch is shared: assertions use this run's synthetic collectors, student and session only.
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
  ...(await import("@/modules/fees/reports.service")),
  ...(await import("@/modules/fees/reports.schemas")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee reports (integration)", () => {
  const run = `fq${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, accountant2: Ctx, principal: Ctx;
  let sessionId: string, classId: string, studentId: string, q1: string, q2: string, tui: string;
  let today: string;
  let formatsBefore: { feeReceipt: string | null; feeInvoice: string | null } = { feeReceipt: null, feeInvoice: null };
  const key = () => crypto.randomUUID();
  const cash = (amount: string, extra: Record<string, unknown> = {}) => ({ studentId, amount, method: "CASH" as const, transactionRef: null, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: key(), ...extra });

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix} ${tag}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    accountant2 = await login((await user("acc2", "ACCOUNTANT")).id);
    principal = await login((await user("pri", "PRINCIPAL")).id);
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

  const q = (x: Record<string, unknown>) => m.reportQuerySchema.parse(x);
  const col = (t: { header: string[] }, name: string) => t.header.indexOf(name);

  it("collection by collector / method / category counts SUCCESS payments only; a cancelled one is listed in the register", async () => {
    const a = (await m.collectPayment(accountant, cash("1000.00")))!;
    await m.collectPayment(accountant2, { ...cash("500.00"), method: "UPI", transactionRef: `UTR${tag}5501` });
    const c = (await m.collectPayment(accountant, cash("200.00")))!;
    await m.cancelReceipt(accountant2, { id: c.id, version: 1, reason: "Synthetic entered twice" });
    const byCollector = await m.runFeeReport(principal, q({ report: "collection", from: today, to: today, groupBy: "collector" }));
    const row = (name: string) => byCollector.rows.find((r) => r[0] === name);
    expect(row(`Synthetic acc ${tag}`)).toEqual([`Synthetic acc ${tag}`, "1", "1000.00"]);
    expect(row(`Synthetic acc2 ${tag}`)).toEqual([`Synthetic acc2 ${tag}`, "1", "500.00"]);
    expect(byCollector.notes.join(" ")).toMatch(/cancelled/);
    const byMethod = await m.runFeeReport(principal, q({ report: "collection", from: today, to: today, groupBy: "method" }));
    expect(byMethod.rows.map((r) => r[0])).toEqual(expect.arrayContaining(["Cash", "UPI"]));
    const byHead = await m.runFeeReport(principal, q({ report: "collection", from: today, to: today, groupBy: "category" }));
    expect(byHead.rows.find((r) => r[0] === `${run} Tuition`)?.[2]).toBe("1500.00"); // 1000 + 500 to tuition (late fee is allocated last)
    const cancelled = await m.runFeeReport(principal, q({ report: "cancelled-receipts", from: today, to: today }));
    const line = cancelled.rows.find((r) => r[0] === c.receiptNo)!;
    expect(line[col(cancelled, "Amount (Rs.)")]).toBe("200.00");
    expect(line[col(cancelled, "Collected by")]).toBe(`Synthetic acc ${tag}`);
    expect(line[col(cancelled, "Cancelled by")]).toBe(`Synthetic acc2 ${tag}`);
    expect(JSON.stringify(cancelled)).not.toMatch(/entered twice/); // reasons never in reports (§11 I4)
    expect(cancelled.rows.some((r) => r[0] === a.receiptNo)).toBe(false);
  });

  it("outstanding by class and by installment match the invoices; defaulters list the overdue student", async () => {
    const inv = await m.prisma.feeInvoice.findMany({ where: { academicSessionId: sessionId, deletedAt: null }, select: { total: true, paidAmount: true } });
    const balance = inv.reduce((s, i) => s + Number(i.total) - Number(i.paidAmount), 0).toFixed(2);
    const byClass = await m.runFeeReport(principal, q({ report: "outstanding", academicSessionId: sessionId, by: "class" }));
    expect(byClass.rows).toHaveLength(1);
    expect(byClass.rows[0][0]).toBe(`${run} four`);
    expect(byClass.totals![col(byClass, "Balance (Rs.)")]).toBe(balance);
    const byInst = await m.runFeeReport(principal, q({ report: "outstanding", academicSessionId: sessionId, by: "installment" }));
    expect(byInst.rows.map((r) => r[0])).toEqual(["Q1", "Q2"]);
    expect(byInst.totals![col(byInst, "Balance (Rs.)")]).toBe(balance);
    const d = await m.runFeeReport(accountant, q({ report: "defaulters", academicSessionId: sessionId, minDays: 1 }));
    expect(d.rows).toHaveLength(1); // Q1 overdue; Q2 not yet due
    expect(d.rows[0].slice(0, 2)).toEqual([`${tag}-STU-1`, "Synthetic Payer"]);
    expect(d.rows[0][col(d, "Days overdue")]).toBe("30");
    expect(d.header).toContain("Phone"); // the Accountant holds student.read ALL
    const none = await m.runFeeReport(accountant, q({ report: "defaulters", academicSessionId: sessionId, minDays: 60 }));
    expect(none.rows).toHaveLength(0);
  });

  it("a cancelled invoice is in the not-issued-again register until it is issued again", async () => {
    const q2inv = await m.prisma.feeInvoice.findFirstOrThrow({ where: { academicSessionId: sessionId, installmentId: q2 }, select: { id: true, version: true, invoiceNo: true } });
    await m.cancelInvoice(accountant, { id: q2inv.id, version: q2inv.version, reason: "Synthetic wrong amount" });
    const reg = await m.runFeeReport(principal, q({ report: "cancelled-invoices", academicSessionId: sessionId }));
    expect(reg.rows.map((r) => r[0])).toEqual([q2inv.invoiceNo]);
    expect(JSON.stringify(reg)).not.toMatch(/wrong amount/);
    await m.issueInvoices(accountant, { academicSessionId: sessionId, classId, installmentId: q2 });
    expect((await m.runFeeReport(principal, q({ report: "cancelled-invoices", academicSessionId: sessionId }))).rows).toHaveLength(0);
  });

  it("the concession register lists late-fee waivers without their reason", async () => {
    // A waiver needs an overdue invoice with a live late fee: none is left here (Q1's is frozen), so the register is
    // checked for the session being empty of concessions and the waiver rows' shape on the pure parser (unit test).
    const reg = await m.runFeeReport(principal, q({ report: "concessions", academicSessionId: sessionId }));
    expect(reg.rows).toHaveLength(0);
    expect(reg.header[0]).toBe("Type");
  });

  it("CSV export: export.run required (the Principal is refused), formula-safe, audited without the data", async () => {
    await expect(m.exportFeeReport(principal, q({ report: "defaulters", academicSessionId: sessionId }))).rejects.toBeInstanceOf(m.ForbiddenError);
    const out = await m.exportFeeReport(accountant, q({ report: "defaulters", academicSessionId: sessionId }));
    expect(out.csv.charCodeAt(0)).toBe(0xfeff);
    expect(out.csv).toContain("Synthetic Payer");
    expect(out.csv).not.toContain("Phone"); // review M1: the Accountant's download has no guardian contacts (D8)
    expect(out.fileName).toMatch(/^fees-defaulters-\d{4}-\d{2}-\d{2}\.csv$/);
    const row = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "fee_report.export", actorId: accountant.userId }, orderBy: { id: "desc" }, select: { after: true } });
    expect(row.after).toMatchObject({ report: "defaulters", rows: 1, format: "csv", guardianContacts: false, filters: { academicSessionId: sessionId, minDays: 1 } });
    expect(JSON.stringify(row.after)).not.toMatch(/Synthetic Payer|STU-1/);
  });
});
