import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 6C-M3 — UPI payment intimation against real Postgres (PHASE_6_PLAN.md §6 6C-M3). PENDING until KI-059 and
 * migration 20261128000000 on Test. Synthetic data only (fixture as in fees-collection.test.ts).
 * - duplicate references refused (another live claim, a live receipt); over-claims refused at submit and at confirm;
 * - confirm creates exactly one receipt under concurrency (two Accountants); confirm ≠ submitter; reject frees the
 *   reference; the parent sees the status only; students, staff and other families can't use the parent's page.
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
  ...(await import("@/modules/fees/payment-claims.service")),
  ...(await import("@/modules/fees/payment-claims.portal")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("payment claims (integration)", () => {
  const run = `pc${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, accountant2: Ctx, admin: Ctx, parent: Ctx, otherParent: Ctx, studentAccount: Ctx;
  let portalBefore: unknown = null;
  let sessionId: string, classId: string, studentId: string, otherStudentId: string;
  let today: string;
  let window: { today: string; leaverAccessDays: number };
  let formatsBefore: { feeReceipt: string | null; feeInvoice: string | null } = { feeReceipt: null, feeInvoice: null };
  let seq = 0;
  const utr = () => `9${String(Date.now() % 1e8).padStart(8, "0")}${String(seq++ % 1000).padStart(3, "0")}`;
  const claim = (ctx: Ctx, amount: string, transactionRef: string, sid = studentId) => m.submitPortalClaim(ctx, { studentId: sid, amount, method: "UPI", transactionRef, paidOn: today }, window);
  const version = async (id: string) => (await m.prisma.feePaymentClaim.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;

  async function user(suffix: string, roleKey: string, extra: Record<string, unknown> = {}) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", ...extra, roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;
  async function pupil(n: number, sectionId: string, start: Date) {
    const s = await m.prisma.student.create({
      data: { studentCode: `${tag}-STU-${n}`, admissionNo: `${tag}-ADM-${n}`, firstName: "Synthetic", fullName: `Synthetic Payer ${n}`, fullNameNormalized: `synthetic payer ${n}`, dob: d("2018-06-01"), gender: "OTHER", admissionDate: start, admittedSessionId: sessionId },
    });
    await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId, enrolledOn: start } });
    const g = await m.prisma.guardian.create({ data: { name: `Synthetic Guardian ${n}`, phone: `109${String(Date.now() % 1e6).padStart(6, "0")}${n}` } });
    await m.prisma.studentGuardian.create({ data: { studentId: s.id, guardianId: g.id, relation: "MOTHER" } });
    return { studentId: s.id, guardianId: g.id };
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    accountant2 = await login((await user("acc2", "ACCOUNTANT")).id);
    admin = await login((await user("sa", "SCHOOL_ADMIN")).id);
    portalBefore = ((await m.prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { features: true } }))?.features ?? null) as unknown;
    await m.updatePortalPaymentSettings(admin, { payeeName: "Demo Public School", vpa: "demo.school@examplebank", leaverAccessDays: 180, studentAccounts: false, studentMinClassLevel: 9 });
    formatsBefore = await m.getFeeNumberFormats(accountant);
    await m.updateFeeNumberFormats(admin, { feeReceipt: `R${tag}/{SEQ:5}`, feeInvoice: `I${tag}/{SEQ:5}` });
    today = m.todayInTimeZone();
    window = { today, leaverAccessDays: 180 };
    const start = new Date(d(today).getTime() - 90 * 86_400_000);
    const end = new Date(d(today).getTime() + 200 * 86_400_000);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-now`, startDate: start, endDate: end, status: "ACTIVE" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C5`, name: `${run} five`, nameKey: `${run} five`, numericLevel: 5 } })).id;
    const sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId, name: "A", nameKey: "a", code: `${tag}C5-A`, capacity: 40 } })).id;
    const a = await pupil(1, sectionId, start);
    const b = await pupil(2, sectionId, start);
    studentId = a.studentId;
    otherStudentId = b.studentId;
    parent = await login((await user("pa", "PARENT", { guardianId: a.guardianId, privacyConsentAt: new Date(), privacyConsentVersion: "1" })).id);
    otherParent = await login((await user("pb", "PARENT", { guardianId: b.guardianId, privacyConsentAt: new Date(), privacyConsentVersion: "1" })).id);
    studentAccount = await login((await user("st", "STUDENT", { studentId, privacyConsentAt: new Date(), privacyConsentVersion: "1" })).id);
    const tui = (await m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Tuition`, kind: "REGULAR", appliesTo: "ALL" }))!.id;
    const q1 = (await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Q1", dueOn: iso(new Date(d(today).getTime() - 30 * 86_400_000)), sortOrder: 0 }))!.id;
    await m.createFeeStructure(accountant, { academicSessionId: sessionId, classId, name: "Five", items: [{ categoryId: tui, installmentId: q1, amount: "3000.00" }] });
    await m.issueInvoices(accountant, { academicSessionId: sessionId, classId, installmentId: q1 });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const ids = [studentId, otherStudentId].filter((x): x is string => !!x); // beforeAll may have stopped early
    await prisma.notification.deleteMany({ where: { user: { username: { startsWith: run } } } });
    await prisma.feePaymentClaim.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE fee_payment_allocation DISABLE TRIGGER fee_payment_allocation_immutable`;
      await tx.$executeRaw`ALTER TABLE fee_payment DISABLE TRIGGER fee_payment_immutable`;
      await tx.feePaymentAllocation.deleteMany({ where: { studentId: { in: ids } } });
      await tx.feePayment.deleteMany({ where: { studentId: { in: ids } } });
      await tx.$executeRaw`ALTER TABLE fee_payment ENABLE TRIGGER fee_payment_immutable`;
      await tx.$executeRaw`ALTER TABLE fee_payment_allocation ENABLE TRIGGER fee_payment_allocation_immutable`;
    });
    await prisma.feeInvoiceItem.deleteMany({ where: { invoice: { academicSessionId: sessionId } } });
    await prisma.feeInvoice.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeStructure.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeInstallment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeCategory.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.schoolSetting.updateMany({ where: { id: "default" }, data: { features: (portalBefore ?? {}) as object } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    const runGuardians = (await prisma.studentGuardian.findMany({ where: { studentId: { in: ids } }, select: { guardianId: true } })).map((l) => l.guardianId);
    await prisma.studentGuardian.deleteMany({ where: { studentId: { in: ids } } });
    await prisma.guardian.deleteMany({ where: { id: { in: runGuardians } } }); // only this run's (never other suites' leftovers)
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { id: { in: ids } } });
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
    await prisma.$disconnect();
  }, 180_000);

  // The parents' 5-claims-a-day limit lives in the database; the cases below submit more than 5 as one parent.
  beforeEach(async () => {
    const { RULES, subjectPrefix } = await import("@/lib/rate-limit");
    for (const ctx of [parent, otherParent]) if (ctx) await m.prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: subjectPrefix(RULES.paymentClaim, ctx.userId) } } });
  });

  it("only the child's parent may use the page; students, staff and other families get the same NotFound", async () => {
    expect((await m.getPortalPayPage(parent, studentId, window)).dueToday).toBe("3000.00");
    await expect(m.getPortalPayPage(otherParent, studentId, window)).rejects.toThrow("Not found.");
    // A student account holds no fee permission at all: refused by the permission check first (403), no data either way.
    await expect(m.getPortalPayPage(studentAccount, studentId, window)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.getPortalPayPage(accountant, studentId, window)).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(claim(otherParent, "100", utr())).rejects.toThrow("Not found.");
  });

  it("submit: within the dues; a reference can't be reused by a live claim or a live receipt; audit without amount", async () => {
    await expect(claim(parent, "3000.01", utr())).rejects.toBeInstanceOf(m.ValidationError);
    await expect(claim(parent, "100", "12345")).rejects.toBeInstanceOf(m.ValidationError); // not 12 digits
    const ref = utr();
    const { id } = await claim(parent, "1000", ref);
    await expect(claim(parent, "1000", ref)).rejects.toBeInstanceOf(m.ConflictError);
    // A reference on a live counter receipt.
    const counterRef = utr();
    await m.collectPayment(accountant, { studentId: otherStudentId, amount: "10", method: "UPI", transactionRef: counterRef, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: crypto.randomUUID() });
    await expect(claim(parent, "100", counterRef)).rejects.toBeInstanceOf(m.ConflictError);
    const log = await m.prisma.auditLog.findFirstOrThrow({ where: { action: "fee_claim.submit", entityId: id } });
    expect(JSON.stringify(log.after)).not.toMatch(/1000|transactionRef/);
    expect(JSON.stringify(log.after)).not.toContain(ref);
  });

  it("confirm under concurrency: exactly one receipt; the claim carries it; the parent sees the status only", async () => {
    const [c] = await m.prisma.feePaymentClaim.findMany({ where: { studentId, status: "SUBMITTED" }, take: 1 });
    const v = await version(c.id);
    const results = await Promise.allSettled([m.confirmPaymentClaim(accountant, { id: c.id, version: v }), m.confirmPaymentClaim(accountant2, { id: c.id, version: v })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(m.ConflictError);
    const after = await m.prisma.feePaymentClaim.findUniqueOrThrow({ where: { id: c.id }, select: { status: true, paymentId: true } });
    expect(after.status).toBe("CONFIRMED");
    expect(await m.prisma.feePayment.count({ where: { studentId, idempotencyKey: `claim:${c.id}` } })).toBe(1);
    const page = await m.getPortalPayPage(parent, studentId, window);
    expect(page.dueToday).toBe("2000.00");
    const shown = page.claims.find((x) => x.id === c.id)!;
    expect(shown.status).toBe("CONFIRMED");
    expect(Object.keys(shown).sort()).toEqual(["amount", "createdAt", "id", "method", "paidOn", "receiptCancelled", "refEnd", "status"]);
  });

  it("reject frees the reference; the reason stays office-only; the submitter can never decide", async () => {
    const ref = utr();
    const { id } = await claim(parent, "500", ref);
    await m.rejectPaymentClaim(accountant, { id, version: await version(id), reason: "Synthetic: not on the statement" });
    expect(JSON.stringify(await m.getPortalPayPage(parent, studentId, window))).not.toContain("not on the statement");
    const again = await claim(parent, "500", ref); // freed
    // A claim whose submitter is the deciding Accountant (fixture) can't be decided by them.
    await m.prisma.feePaymentClaim.update({ where: { id: again.id }, data: { submittedById: accountant.userId } });
    await expect(m.confirmPaymentClaim(accountant, { id: again.id, version: await version(again.id) })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.rejectPaymentClaim(accountant, { id: again.id, version: await version(again.id), reason: "Synthetic" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.rejectPaymentClaim(accountant2, { id: again.id, version: await version(again.id), reason: "Synthetic cleanup" });
  });

  it("over-claim at confirm (the dues fell since): refused, nothing changes", async () => {
    const { id } = await claim(parent, "2000", utr());
    await m.collectPayment(accountant, { studentId, amount: "1500", method: "CASH", transactionRef: null, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: crypto.randomUUID() });
    await expect(m.confirmPaymentClaim(accountant, { id, version: await version(id) })).rejects.toBeInstanceOf(m.ValidationError);
    expect((await m.prisma.feePaymentClaim.findUniqueOrThrow({ where: { id }, select: { status: true } })).status).toBe("SUBMITTED");
    expect(await m.prisma.feePayment.count({ where: { idempotencyKey: `claim:${id}` } })).toBe(0);
  });

  it("review M1: a UTR the counter recorded with a prefix can't be claimed again (submit) nor confirmed (confirm)", async () => {
    const bare = utr();
    // A claim submitted first, then the same UTR recorded at the counter with a "UTR" prefix.
    const { id } = await claim(parent, "50", bare);
    await m.collectPayment(accountant, { studentId, amount: "50", method: "UPI", transactionRef: `UTR ${bare}`, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: crypto.randomUUID() });
    await expect(m.confirmPaymentClaim(accountant2, { id, version: await version(id) })).rejects.toBeInstanceOf(m.ConflictError);
    expect(await m.prisma.feePayment.count({ where: { idempotencyKey: `claim:${id}` } })).toBe(0);
    await m.rejectPaymentClaim(accountant2, { id, version: await version(id), reason: "Synthetic: paid at the counter" });
    await expect(claim(parent, "50", bare)).rejects.toBeInstanceOf(m.ConflictError); // now on a live receipt (prefixed)
  });

  it("review M1b: after a claim was confirmed, the counter can't collect the same UTR again with a prefix", async () => {
    const bare = utr();
    const { id } = await claim(parent, "20", bare);
    await m.confirmPaymentClaim(accountant, { id, version: await version(id) });
    await expect(
      m.collectPayment(accountant2, { studentId, amount: "20", method: "UPI", transactionRef: `UTR/${bare}`, bankName: null, instrumentDate: null, paidOn: today, invoiceIds: [], waiveLateFeeInvoiceIds: [], waiveReason: null, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(m.ConflictError);
  });

  it("review L1: no claims while the school's UPI details are cleared", async () => {
    await m.updatePortalPaymentSettings(admin, { payeeName: "", vpa: "", leaverAccessDays: 180, studentAccounts: false, studentMinClassLevel: 9 });
    await expect(claim(parent, "10", utr())).rejects.toBeInstanceOf(m.ConflictError);
    await m.updatePortalPaymentSettings(admin, { payeeName: "Demo Public School", vpa: "demo.school@examplebank", leaverAccessDays: 180, studentAccounts: false, studentMinClassLevel: 9 });
  });

  it("review M2: every seeded role without fee.collect ALL is refused the queue, confirm and reject; without settings.manage the UPI settings", async () => {
    const { ROLES, normalizeGrant } = await import("@/lib/rbac/catalog");
    const [c] = await m.prisma.feePaymentClaim.findMany({ where: { studentId }, take: 1, select: { id: true, version: true } });
    for (const role of ROLES) {
      // Portal roles need a linked guardian / student to sign in at all — refused in the first case of this suite.
      if (role.key === "SUPER_ADMIN" || role.key === "PARENT" || role.key === "STUDENT") continue;
      const grants = role.grants.map(normalizeGrant);
      const ctx = await login((await user(`r-${role.key.toLowerCase()}`, role.key)).id);
      const collects = !ctx.portal && grants.some((g) => g.key === "fee.collect" && g.scope === "ALL");
      if (!collects) {
        await expect(m.listPaymentClaims(ctx), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
        await expect(m.confirmPaymentClaim(ctx, { id: c.id, version: c.version }), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
        await expect(m.rejectPaymentClaim(ctx, { id: c.id, version: c.version, reason: "Synthetic" }), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
      } else {
        await expect(m.listPaymentClaims(ctx), role.key).resolves.toBeTruthy();
      }
      if (!grants.some((g) => g.key === "settings.manage")) {
        await expect(m.updatePortalPaymentSettings(ctx, { payeeName: "Evil", vpa: "evil@bank", leaverAccessDays: 1, studentAccounts: false, studentMinClassLevel: 9 }), role.key).rejects.toBeInstanceOf(m.ForbiddenError);
      }
    }
    expect((await m.getPortalSettingsForOffice(admin)).upi?.vpa).toBe("demo.school@examplebank");
  }, 120_000);

  it("the database refuses impossible rows", async () => {
    const base = { studentId, method: "UPI" as const, transactionRef: utr(), paidOn: d(today), submittedById: parent.userId };
    await expect(m.prisma.feePaymentClaim.create({ data: { ...base, amount: "0" } })).rejects.toThrow();
    await expect(m.prisma.feePaymentClaim.create({ data: { ...base, amount: "1", status: "CONFIRMED" } })).rejects.toThrow(); // no payment
    await expect(m.prisma.feePaymentClaim.create({ data: { ...base, amount: "1", status: "REJECTED", decidedAt: new Date() } })).rejects.toThrow(); // no reason
    await expect(m.prisma.feePaymentClaim.create({ data: { ...base, amount: "1", decidedById: parent.userId, status: "REJECTED", rejectReason: "x", decidedAt: new Date() } })).rejects.toThrow(); // decider = submitter
  });
});
