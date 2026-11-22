import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5C-M3 previous dues (opening balances) against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * Template, preview (no writes), confirm (numbered OPENING_BALANCE invoice, previewed total enforced), idempotent
 * re-run, collected first at the counter, closed session and other roles refused. Uses this run's data only.
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
  ...(await import("@/modules/fees/opening-balances.service")),
  
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee previous dues (integration)", () => {
  const run = `fo${Date.now().toString(36)}`;
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

  const ref = () => ({ academicSessionId: sessionId, classId });
  const csvFile = (rows: string[][]) => ({ bytes: new TextEncoder().encode(rows.map((r) => r.join(",")).join("\n")), fileName: "dues.csv" });
  const header = ["Student ID", "Name", "Class", "Section", "Previous dues (Rs.)"];
  // 25 days back: inside the fixture session (it starts 90 days back) and within the 30-day bound (review L1).
  const earlier = () => new Date(Date.parse(`${today}T00:00:00Z`) - 25 * 86_400_000).toISOString().slice(0, 10);

  it("template lists the class; preview writes nothing; confirm adds one numbered 'Previous dues' invoice", async () => {
    const t = await m.openingTemplate(accountant, ref(), "csv");
    expect(new TextDecoder().decode(t.body)).toContain(`${tag}-STU-1`);
    const before = await m.prisma.feeInvoice.count({ where: { academicSessionId: sessionId } });
    const p = await m.previewOpeningImport(accountant, ref(), csvFile([header, [`${tag}-STU-1`, "Synthetic Payer", "", "", "Rs. 1,250.50"]]));
    expect(p.canConfirm).toBe(true);
    expect(p.plan.total).toBe("1250.50");
    expect(await m.prisma.feeInvoice.count({ where: { academicSessionId: sessionId } })).toBe(before);
    // Review the import: a total other than the previewed one is refused.
    await expect(m.importOpeningBalances(accountant, { ...ref(), dueOn: earlier(), entries: p.plan.entries, expectedTotal: "1.00" })).rejects.toThrow(/doesn't match the preview/);
    const r = await m.importOpeningBalances(accountant, { ...ref(), dueOn: earlier(), entries: p.plan.entries, expectedTotal: p.plan.total });
    expect(r).toEqual({ created: 1, skipped: 0, total: "1250.50" });
    const inv = await m.prisma.feeInvoice.findFirstOrThrow({ where: { academicSessionId: sessionId, kind: "OPENING_BALANCE", deletedAt: null }, select: { invoiceNo: true, total: true, status: true, installmentId: true, structureId: true, items: { select: { kind: true, description: true, amount: true } } } });
    expect(inv.invoiceNo.startsWith(`I${tag}/`)).toBe(true);
    expect(inv).toMatchObject({ status: "ISSUED", installmentId: null, structureId: null });
    expect(inv.total.toFixed(2)).toBe("1250.50");
    expect(inv.items.map((i) => [i.kind, i.description, i.amount.toFixed(2)])).toEqual([["OPENING_BALANCE", "Previous dues", "1250.50"]]);
    const audit = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "fee_opening.import", actorId: accountant.userId }, orderBy: { id: "desc" }, select: { after: true } });
    expect(audit.after).toMatchObject({ created: 1, skipped: 0 });
    expect(audit.after).not.toHaveProperty("total"); // review L3: one student's amount is never audited
    expect(JSON.stringify(audit.after)).not.toMatch(/STU-1|Synthetic Payer/);
  });

  it("re-running is idempotent: the student is shown as already added and skipped on confirm", async () => {
    const p = await m.previewOpeningImport(accountant, ref(), csvFile([header, [`${tag}-STU-1`, "", "", "", "999"]]));
    expect(p.plan.counts).toMatchObject({ new: 0, existing: 1 });
    expect(p.canConfirm).toBe(false);
    const sid = (await m.prisma.student.findFirstOrThrow({ where: { studentCode: `${tag}-STU-1` }, select: { id: true } })).id;
    expect(await m.importOpeningBalances(accountant, { ...ref(), dueOn: today, entries: [{ studentId: sid, amount: "999.00" }], expectedTotal: "999.00" })).toEqual({ created: 0, skipped: 1, total: "0.00" });
    expect(await m.prisma.feeInvoice.count({ where: { academicSessionId: sessionId, kind: "OPENING_BALANCE", deletedAt: null } })).toBe(1);
  });

  it("review L1: a due date outside the session or long past is refused", async () => {
    const sid = (await m.prisma.student.findFirstOrThrow({ where: { studentCode: `${tag}-STU-1` }, select: { id: true } })).id;
    const far = new Date(Date.parse(`${today}T00:00:00Z`) + 400 * 86_400_000).toISOString().slice(0, 10);
    const old = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
    // A fresh session-less check: cancel the existing previous dues first so the import would create one.
    const inv = await m.prisma.feeInvoice.findFirstOrThrow({ where: { academicSessionId: sessionId, kind: "OPENING_BALANCE", deletedAt: null }, select: { id: true, version: true } });
    await m.cancelInvoice(accountant, { id: inv.id, version: inv.version, reason: "Synthetic re-import" });
    await expect(m.importOpeningBalances(accountant, { ...ref(), dueOn: far, entries: [{ studentId: sid, amount: "1250.50" }], expectedTotal: "1250.50" })).rejects.toThrow(/within the academic session/);
    await expect(m.importOpeningBalances(accountant, { ...ref(), dueOn: old, entries: [{ studentId: sid, amount: "1250.50" }], expectedTotal: "1250.50" })).rejects.toThrow(/30 days/);
    expect((await m.importOpeningBalances(accountant, { ...ref(), dueOn: earlier(), entries: [{ studentId: sid, amount: "1250.50" }], expectedTotal: "1250.50" }))!.created).toBe(1);
  });

  it("previous dues are collected at the counter and get the session's late fee once overdue", async () => {
    const view = await m.getCounterView(accountant, studentId);
    const prev = view.invoices.find((i) => i.installmentName === "Previous dues")!;
    expect(prev).toBeDefined();
    await m.collectPayment(accountant, cash("1250.50", { invoiceIds: [prev.id] }));
    const inv = await m.prisma.feeInvoice.findFirstOrThrow({ where: { academicSessionId: sessionId, kind: "OPENING_BALANCE" }, select: { status: true, lateFee: true, total: true } });
    // The session's FLAT late fee (100) applies to overdue previous dues too, and the cash covered only 1250.50.
    expect(inv.lateFee.toFixed(2)).toBe("100.00");
    expect(inv.status).toBe("PARTIAL");
  });

  it("a file problem blocks the import; a closed session is refused; other roles are refused", async () => {
    const bad = await m.previewOpeningImport(accountant, ref(), csvFile([header, ["NOT-A-STUDENT", "", "", "", "10"]]));
    expect(bad.canConfirm).toBe(false);
    expect(bad.plan.counts.problems).toBe(1);
    await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "CLOSED" } });
    try {
      await expect(m.previewOpeningImport(accountant, ref(), csvFile([header]))).rejects.toThrow(/closed/);
      await expect(m.importOpeningBalances(accountant, { ...ref(), dueOn: today, entries: [{ studentId, amount: "1.00" }], expectedTotal: "1.00" })).rejects.toThrow(/closed/);
    } finally {
      await m.prisma.academicSession.update({ where: { id: sessionId }, data: { status: "ACTIVE" } });
    }
    await expect(m.openingTemplate(principal, ref(), "csv")).rejects.toBeInstanceOf(m.ForbiddenError);
  });
});
