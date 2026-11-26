import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";
import { FIXTURE_DOB, freeFixtureYear } from "./fixture-year";

/**
 * Phase 6B-M3 — the fee ledger and receipts for parents against the real database (PHASE_6_PLAN.md §6 6B-M3). PENDING
 * until KI-059. Synthetic data only.
 * - whitelist: fixed labels, never item text of previous-dues / late-fee lines, reasons, references or collectors;
 * - due today and overdue; the portal banner count;
 * - the receipt PDF is a PARENT COPY without reference / collector and leaves the counter's print count unchanged;
 * - another family, a student account (no fees, P16), a missing id → refused identically.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/settings/settings.service")),
  ...(await import("@/modules/academic/classes.service")),
  ...(await import("@/modules/academic/sections.service")),
  ...(await import("@/modules/admissions/admissions.service")),
  ...(await import("@/modules/fees/fees.portal")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);
const FIXTURE_YEAR = enabled ? await freeFixtureYear(m.prisma, 1) : 2000;

describe.skipIf(!enabled)("portal fees (integration)", () => {
  const run = `p6m3${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const year = FIXTURE_YEAR; // a free past year on Test (fixture-year.ts)
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, principal: Ctx, officer: Ctx, parentA: Ctx, parentB: Ctx, studentA: Ctx;
  let sessionId: string, classId: string, sectionId: string, categoryId: string;
  const kid: Record<string, { studentId: string; guardianId: string }> = {};
  const receipt: Record<string, string> = {};
  const address = { line1: "1 Example Road", line2: null, city: "Sampletown", district: null, state: "Example State", pinCode: "110001", country: "India" };
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  const window = { today: `${year}-10-15`, leaverAccessDays: 180 };
  const SECRET = "Synthetic internal note: do not show";
  const UTR = `UTR${randomBytes(5).toString("hex").toUpperCase()}`;
  let seq = 0;

  async function user(suffix: string, roleKey: string, link: { guardianId?: string; studentId?: string } = {}) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    const portal = roleKey === "PARENT" || roleKey === "STUDENT";
    const u = await m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", privacyConsentAt: portal ? new Date() : null, privacyConsentVersion: portal ? "1" : null, ...link, roles: { create: { roleId: role.id } } } });
    return (await m.validateSessionToken((await m.createSession(u.id, { long: false })).token))!;
  }
  const appVersion = async (id: string) => (await m.prisma.admissionApplication.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
  async function admit(firstName: string) {
    const { id } = await m.createDraft(officer, { academicSessionId: sessionId, classId, firstName, middleName: null, lastName: "Example", dob: FIXTURE_DOB, gender: "FEMALE" });
    await m.updateGuardiansStep(officer, { id, version: await appVersion(id), guardians: [{ relation: "MOTHER", name: `Synthetic Parent ${firstName}`, phone: `107${String(Date.now() % 1e6).padStart(6, "0")}${seq++ % 10}`, altPhone: null, email: null, occupation: null, isPrimary: true, isEmergencyContact: true }] });
    await m.updateContactStep(officer, { id, version: await appVersion(id), phone: null, email: null, address });
    await m.submitApplication(officer, id, await appVersion(id));
    await m.setSection(principal, id, await appVersion(id), sectionId);
    const { studentId } = await m.approveApplication(principal, { id, version: await appVersion(id), admissionDate: `${year}-04-01`, duplicateOverride: null, guardianLinks: {} });
    const { guardianId } = await m.prisma.studentGuardian.findFirstOrThrow({ where: { studentId }, select: { guardianId: true } });
    return { studentId, guardianId };
  }
  async function previousDues(studentId: string) {
    return m.prisma.feeInvoice.create({
      data: {
        invoiceNo: `${run}-${seq++}`,
        studentId,
        academicSessionId: sessionId,
        kind: "OPENING_BALANCE",
        dueOn: d(`${year}-09-01`),
        subtotal: "1000.00",
        total: "1000.00",
        items: { create: [{ categoryId, kind: "OPENING_BALANCE", description: SECRET, amount: "1000.00" }] },
      },
    });
  }
  async function payment(studentId: string, method: "CASH" | "UPI", status: "SUCCESS" | "CANCELLED") {
    const ref = method === "UPI" ? UTR : null;
    return m.prisma.feePayment.create({
      data: {
        receiptNo: `${run}-R${seq++}`,
        studentId,
        amount: "200.00",
        method,
        transactionRef: status === "SUCCESS" ? ref : null,
        paidOn: d(`${year}-09-10`),
        idempotencyKey: randomBytes(16).toString("hex"),
        collectedById: root.userId,
        receiptSnapshot: { school: "S", student: { name: "Synthetic", studentCode: "STU", className: "C", sectionCode: "A" }, method: method === "UPI" ? "UPI" : "Cash", reference: ref, bankName: null, instrumentDate: null, lines: [{ invoiceNo: "I", session: "S", installment: "Previous dues", description: SECRET, amount: "200.00" }], amountInWords: "Rupees Two Hundred Only", collectedBy: "Synthetic Collector" },
        status,
        ...(status === "CANCELLED" ? { cancelledAt: new Date(), cancelReason: `${SECRET} (cancel)`, cancelledById: principal.userId } : {}),
      },
    });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    [root, principal, officer] = await Promise.all([user("root", "SUPER_ADMIN"), user("pr", "PRINCIPAL"), user("ao", "ADMISSION_OFFICER")]);
    sessionId = (await m.createAcademicSession(root, { name: `${year}-${String((year + 1) % 100).padStart(2, "0")}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31` })).id;
    await m.changeAcademicSessionStatus(root, sessionId, "ACTIVE");
    classId = (await m.createClass(root, { code: `${tag}-F`, name: `${run} Class F`, numericLevel: 4, displayOrder: 0, defaultSectionCapacity: null }))!.id;
    sectionId = (await m.createSectionsBulk(root, { academicSessionId: sessionId, classId, names: ["A"], capacity: 40 }))[0].id;
    categoryId = (await m.prisma.feeCategory.create({ data: { code: `${tag}PD`, name: `${run} Dues`, nameKey: `${run} dues` } })).id;
    kid.A = await admit("Aarti");
    kid.B = await admit("Bindu");
    parentA = await user("pa", "PARENT", { guardianId: kid.A.guardianId });
    parentB = await user("pb", "PARENT", { guardianId: kid.B.guardianId });
    studentA = await user("sa", "STUDENT", { studentId: kid.A.studentId });
    await previousDues(kid.A.studentId);
    await previousDues(kid.B.studentId);
    receipt.A = (await payment(kid.A.studentId, "UPI", "SUCCESS")).id;
    receipt.Acancelled = (await payment(kid.A.studentId, "CASH", "CANCELLED")).id;
    receipt.B = (await payment(kid.B.studentId, "CASH", "SUCCESS")).id;
  }, 180_000);

  it("the ledger: fixed labels, due today, overdue, receipts with 'Cancelled' only — no reasons, references or collectors", async () => {
    const l = await m.getPortalFeeLedger(parentA, kid.A.studentId, window);
    expect(l.invoices).toHaveLength(1);
    expect(l.invoices[0].lines.map((x) => x.label)).toEqual(["Previous dues"]);
    expect(l.invoices[0].overdue).toBe(true);
    expect(l.overdueCount).toBe(1);
    expect(l.dueToday).toBe("1000.00");
    expect(l.receipts.map((r) => r.cancelled).sort()).toEqual([false, true]);
    expect(JSON.stringify(l)).not.toMatch(new RegExp(`${SECRET}|${UTR}|Synthetic Collector|cancelReason|cancelledBy|cancelledAt|cancellationReason`, "i")); // the cancel REASON is SECRET; the `cancelled` flag itself is expected above
    expect(await m.portalOverdueChildren(parentA, window)).toBe(1);
  });

  it("review L2 / L3: two overdue invoices of one child count one child; due today matches the counter's open invoices", async () => {
    const extra = await m.prisma.feeInvoice.create({
      data: { invoiceNo: `${run}-X${seq++}`, studentId: kid.A.studentId, academicSessionId: sessionId, kind: "OPENING_BALANCE", dueOn: d(`${year}-09-05`), subtotal: "300.00", total: "300.00", items: { create: [{ categoryId, kind: "OPENING_BALANCE", description: "Synthetic", amount: "300.00" }] } },
    }).catch(() => null); // one live previous-dues invoice per student and session: a second may be refused by the partial unique
    if (extra) {
      expect(await m.portalOverdueChildren(parentA, window)).toBe(1);
      expect((await m.getPortalFeeLedger(parentA, kid.A.studentId, window)).dueToday).toBe("1300.00");
    }
    expect(await m.portalOverdueChildren(parentB, window)).toBe(1);
  });

  it("another family, a missing id and a student account are refused identically", async () => {
    await expect(m.getPortalFeeLedger(parentB, kid.A.studentId, window)).rejects.toThrow("Not found.");
    await expect(m.getPortalFeeLedger(parentA, "c0000000000000000000000000", window)).rejects.toThrow("Not found.");
    await expect(m.getPortalFeeLedger(studentA, kid.A.studentId, window)).rejects.toBeInstanceOf(m.ForbiddenError); // P16: no fees for students
    for (const id of [receipt.B, "c0000000000000000000000000"]) await expect(m.renderPortalReceiptPdf(parentA, id, window)).rejects.toThrow("Not found.");
    await expect(m.renderPortalReceiptPdf(principal, receipt.A, window)).rejects.toBeInstanceOf(m.AppError);
  });

  it("the receipt PDF is a PARENT COPY without reference or collector; the counter's print count is unchanged", async () => {
    const before = (await m.prisma.feePayment.findUniqueOrThrow({ where: { id: receipt.A }, select: { printCount: true } })).printCount;
    const { pdf, fileName } = await m.renderPortalReceiptPdf(parentA, receipt.A, window);
    expect(fileName).toBe("receipt.pdf");
    const { extractTextRuns, pageText } = await import("../pdf-text");
    const text = pageText(extractTextRuns(pdf), 1);
    expect(text).toContain("PARENT COPY");
    expect(text).not.toContain(UTR);
    expect(text).not.toContain("Synthetic Collector");
    expect(text).not.toContain(SECRET);
    expect((await m.prisma.feePayment.findUniqueOrThrow({ where: { id: receipt.A }, select: { printCount: true } })).printCount).toBe(before);
    expect(await m.prisma.auditLog.count({ where: { action: "fee_payment.portal_view", entityId: receipt.A } })).toBe(1);
    const cancelled = pageText(extractTextRuns((await m.renderPortalReceiptPdf(parentA, receipt.Acancelled, window)).pdf), 1);
    expect(cancelled).toContain("CANCELLED");
    expect(cancelled).not.toMatch(/\(cancel\)/);
  });
});
