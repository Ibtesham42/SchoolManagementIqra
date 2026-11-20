import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5A-M4 invoice generation against real Postgres (Neon Test only, S-05 guard; skipped without TEST_DATABASE_URL).
 * Preview → issue (consecutive numbers, idempotent re-run, joiner not billed, new-admission head, approved concession,
 * extra charge attached) → structure frozen exactly (KI-103) → re-pricing on approval (FC6) → cancel + re-issue with
 * the charge billed again → ledger. Needs migrations 20261124000000 + 20261125000000 and the Phase 5 catalog on Test.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/fees/setup.service")),
  ...(await import("@/modules/fees/concessions.service")),
  ...(await import("@/modules/fees/invoices.service")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee invoices (integration)", () => {
  const run = `fi${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, principal: Ctx;
  let sessionId: string, closedPrior: string, classId: string, tui: string, adm: string, q1: string, q2: string, structureId: string;
  const students: string[] = [];
  let formatsBefore: { feeReceipt: string | null; feeInvoice: string | null } = { feeReceipt: null, feeInvoice: null };

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    principal = await login((await user("prin", "PRINCIPAL")).id);
    formatsBefore = await m.getFeeNumberFormats(accountant);
    await m.updateFeeNumberFormats(accountant, { feeReceipt: `R${tag}/{SEQ:5}`, feeInvoice: `I${tag}/{SEQ:5}` });
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    closedPrior = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y - 1}`, startDate: d(`${Y - 1}-04-01`), endDate: d(`${Y}-03-31`), status: "CLOSED" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C5`, name: `${run} five`, nameKey: `${run} five`, numericLevel: 5 } })).id;
    const sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId, name: "A", nameKey: "a", code: `${tag}C5-A`, capacity: 40 } })).id;
    const pupils = [
      { n: 1, admitted: sessionId, enrolledOn: `${Y}-04-01` }, // new admission
      { n: 2, admitted: undefined, enrolledOn: `${Y}-04-01` }, // existing (admitted before this session)
      { n: 3, admitted: sessionId, enrolledOn: `${Y}-08-01` }, // joins after Q1
    ];
    for (const p of pupils) {
      const s = await m.prisma.student.create({
        data: { studentCode: `${tag}-STU-${p.n}`, admissionNo: `${tag}-ADM-${p.n}`, firstName: "Synthetic", fullName: `Synthetic Pupil ${p.n}`, fullNameNormalized: `synthetic pupil ${p.n}`, dob: d("2090-06-01"), gender: "OTHER", admissionDate: d(p.enrolledOn), admittedSessionId: p.admitted ?? closedPrior },
      });
      students.push(s.id);
      await m.prisma.studentEnrollment.create({ data: { studentId: s.id, academicSessionId: sessionId, sectionId, enrolledOn: d(p.enrolledOn) } });
    }
    tui = (await m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Tuition`, kind: "REGULAR", appliesTo: "ALL" }))!.id;
    adm = (await m.createFeeCategory(accountant, { code: `${tag}ADM`, name: `${run} Admission`, kind: "ONE_TIME", appliesTo: "NEW_ADMISSION" }))!.id;
    q1 = (await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Q1", dueOn: `${Y}-04-10`, sortOrder: 0 }))!.id;
    q2 = (await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Q2", dueOn: `${Y}-10-10`, sortOrder: 1 }))!.id;
    structureId = (await m.createFeeStructure(accountant, {
      academicSessionId: sessionId,
      classId,
      name: "Five",
      items: [
        { categoryId: tui, installmentId: q1, amount: "3000.00" },
        { categoryId: tui, installmentId: q2, amount: "3000.00" },
        { categoryId: adm, installmentId: q1, amount: "5000.00" },
      ],
    }))!.id;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.feeInvoiceItem.deleteMany({ where: { invoice: { academicSessionId: sessionId } } });
    await prisma.feeInvoice.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.studentConcession.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeConcession.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.studentFeeCharge.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeStructure.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeInstallment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeCategory.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { id: { in: students } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { id: classId } });
    await prisma.academicSession.deleteMany({ where: { id: { in: [sessionId, closedPrior].filter(Boolean) } } });
    // Shared Test settings back as they were.
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

  it("preview → issue: billable students only, admission fee for new admissions, concession and charge applied, consecutive numbers", async () => {
    const [p1, p2, p3] = students;
    const sib = (await m.createConcession(accountant, { code: `${tag}SIB`, name: `${run} Sibling`, kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: [tui] }))!.id;
    const prop = (await m.proposeConcession(accountant, { studentId: p2, academicSessionId: sessionId, concessionId: sib, reason: "Sibling in class 8" }))!.id;
    await m.decideConcession(principal, { id: prop, version: 1, decision: "APPROVE" });
    await m.addCharge(accountant, { studentId: p1, academicSessionId: sessionId, installmentId: q1, categoryId: tui, amount: "250.00", note: "Science club" });
    const run1 = { academicSessionId: sessionId, classId, installmentId: q1 };
    // Review M2: readers can't preview or issue.
    await expect(m.previewInvoices(principal, run1)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.issueInvoices(principal, run1)).rejects.toBeInstanceOf(m.ForbiddenError);
    const preview = await m.previewInvoices(accountant, run1);
    expect(preview.counts).toMatchObject({ roster: 3, notBillable: 1, toIssue: 2 });
    const byStudent = new Map(preview.rows.map((r) => [r.studentId, r]));
    expect(byStudent.get(p1)?.total).toBe("8250.00"); // 3000 + 5000 admission + 250 charge
    expect(byStudent.get(p2)?.total).toBe("2700.00"); // 3000 − 10 %
    expect(byStudent.has(p3)).toBe(false); // joined after Q1
    expect(await m.prisma.feeInvoice.count({ where: { academicSessionId: sessionId } })).toBe(0); // preview wrote nothing
    // Review L3: issuing with figures that differ from the preview is refused.
    await expect(m.issueInvoices(accountant, run1, { count: preview.counts.toIssue, total: "1.00", structureId })).rejects.toThrow(/figures changed/);
    expect((await m.issueInvoices(accountant, run1, { count: preview.counts.toIssue, total: preview.total, structureId }))!.issued).toBe(2);
    const list = await m.listInvoices(principal, run1);
    const nos = list.map((i) => Number(i.invoiceNo.split("/")[1])).sort((a, b) => a - b);
    expect(nos[1] - nos[0]).toBe(1);
    // Idempotent re-run.
    expect((await m.issueInvoices(accountant, run1))!.issued).toBe(0);
    // The charge is now billed.
    expect((await m.listCharges(accountant, sessionId))[0]).toMatchObject({ invoiced: true });
    // Review M3: a new charge for an installment already invoiced is refused (it would never be billed).
    await expect(m.addCharge(accountant, { studentId: p1, academicSessionId: sessionId, installmentId: q1, categoryId: tui, amount: "10.00", note: "Late add" })).rejects.toThrow(/already issued/);
  });

  it("the invoiced structure is frozen exactly (KI-103); a copy stays editable", async () => {
    const st = (await m.listFeeStructures(accountant, sessionId)).find((s) => s.id === structureId)!;
    expect(st.frozen).toBe(true);
    await expect(m.updateFeeStructure(accountant, { id: structureId, version: st.version, name: "Five", items: [{ categoryId: tui, installmentId: q1, amount: "1.00" }] })).rejects.toThrow(/fixed/);
    const copy = await m.copyFeeStructure(accountant, { id: structureId, name: "Five (new)" });
    const c = (await m.listFeeStructures(accountant, sessionId)).find((s) => s.id === copy!.id)!;
    expect(c.frozen).toBe(false);
  });

  it("approving a concession re-prices the student's unpaid invoices (FC6)", async () => {
    const [p1] = students;
    const merit = (await m.createConcession(accountant, { code: `${tag}MER`, name: `${run} Merit`, kind: "SCHOLARSHIP", calc: "FIXED", value: "1000", categoryIds: [tui] }))!.id;
    const prop = (await m.proposeConcession(accountant, { studentId: p1, academicSessionId: sessionId, concessionId: merit, reason: "Merit list" }))!.id;
    await m.decideConcession(principal, { id: prop, version: 1, decision: "APPROVE" });
    const ledger = await m.getStudentFeeLedger(principal, p1);
    expect(ledger.invoices.find((i) => !i.cancelled)).toMatchObject({ concession: "1000.00", total: "7250.00" });
  });

  it("cancel (unpaid only) and re-issue bills the extra charge again; the ledger shows both", async () => {
    const [p1] = students;
    const inv = (await m.listInvoices(accountant, { academicSessionId: sessionId, installmentId: q1 })).find((i) => i.studentId === p1)!;
    await expect(m.cancelInvoice(principal, { id: inv.id, version: inv.version, reason: "Wrong amounts" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.cancelInvoice(accountant, { id: inv.id, version: inv.version, reason: "Wrong amounts" });
    expect((await m.listCharges(accountant, sessionId)).filter((c) => !c.invoiced)).toHaveLength(1);
    expect((await m.issueInvoices(accountant, { academicSessionId: sessionId, classId, installmentId: q1 }))!.issued).toBe(1);
    const ledger = await m.getStudentFeeLedger(principal, p1);
    expect(ledger.invoices.map((i) => i.cancelled).sort()).toEqual([false, true]);
    expect(ledger.balance).toBe("7250.00");
    // Audit rows carry ids, counts and batch totals — no cancel reason.
    const rows = await m.prisma.auditLog.findMany({ where: { entityType: "FeeInvoice", entityId: inv.id }, select: { after: true } });
    expect(JSON.stringify(rows)).not.toMatch(/Wrong amounts/);
  });
});
