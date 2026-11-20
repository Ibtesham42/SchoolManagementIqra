import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5A-M3 concessions (FC6 maker-checker) and charges (FC18) against real Postgres (Neon Test only, S-05 guard;
 * skipped without TEST_DATABASE_URL). Synthetic data in a far-future session; removed in afterAll except audit rows.
 * Needs migration 20261124000000 and the Phase 5 catalog (86 / 312) on Test.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/fees/setup.service")),
  ...(await import("@/modules/fees/concessions.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee concessions and charges (integration)", () => {
  const run = `fc${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, principal: Ctx, superAdmin: Ctx, parent: Ctx;
  let sessionId: string, classId: string, studentId: string, tui: string, inst1: string;
  const categoryIds: string[] = [];
  const concessionIds: string[] = [];

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    principal = await login((await user("prin", "PRINCIPAL")).id);
    superAdmin = { ...(await login((await user("sa", "SUPER_ADMIN")).id)) };
    parent = await login((await user("par", "PARENT")).id);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C7`, name: `${run} seven`, nameKey: `${run} seven`, numericLevel: 7 } })).id;
    const sectionId = (await m.prisma.section.create({ data: { academicSessionId: sessionId, classId, name: "A", nameKey: "a", code: `${tag}C7-A`, capacity: 40 } })).id;
    const s = await m.prisma.student.create({
      data: { studentCode: `${tag}-STU-1`, admissionNo: `${tag}-ADM-1`, firstName: "Synthetic", fullName: "Synthetic Pupil One", fullNameNormalized: "synthetic pupil one", dob: d("2090-06-01"), gender: "OTHER", admissionDate: d(`${Y}-04-01`), admittedSessionId: sessionId },
    });
    studentId = s.id;
    await m.prisma.studentEnrollment.create({ data: { studentId, academicSessionId: sessionId, sectionId, enrolledOn: d(`${Y}-04-01`) } });
    tui = (await m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Tuition`, kind: "REGULAR", appliesTo: "ALL" }))!.id;
    categoryIds.push(tui);
    const dues = [`${Y}-04-10`, `${Y}-07-10`, `${Y}-10-10`, `${Y + 1}-01-10`];
    for (const [i, name] of ["Q1", "Q2", "Q3", "Q4"].entries()) {
      const r = await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name, dueOn: dues[i], sortOrder: i });
      if (i === 0) inst1 = r!.id;
    }
    const insts = await m.listFeeInstallments(accountant, sessionId);
    await m.createFeeStructure(accountant, { academicSessionId: sessionId, classId, name: "Seven", items: insts.map((i) => ({ categoryId: tui, installmentId: i.id, amount: "3000.00" })) });
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    await prisma.studentConcession.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeConcession.deleteMany({ where: { id: { in: concessionIds } } });
    await prisma.studentFeeCharge.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeStructure.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeInstallment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.feeCategory.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma.studentEnrollment.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.student.deleteMany({ where: { studentCode: { startsWith: tag } } });
    await prisma.section.deleteMany({ where: { academicSessionId: sessionId } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: sessionId } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 180_000);

  it("maker-checker: the proposer never decides (Super Admin included); one live row per student and template", async () => {
    const pct = (await m.createConcession(accountant, { code: `${tag}SIB`, name: `${run} Sibling`, kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: [tui] }))!.id;
    const fixed = (await m.createConcession(superAdmin, { code: `${tag}MER`, name: `${run} Merit`, kind: "SCHOLARSHIP", calc: "FIXED", value: "500", categoryIds: [tui] }))!.id;
    concessionIds.push(pct, fixed);
    expect((await m.searchStudentsForFees(accountant, sessionId, "pupil one")).map((s) => s.studentId)).toEqual([studentId]);
    const p1 = (await m.proposeConcession(accountant, { studentId, academicSessionId: sessionId, concessionId: pct, reason: "Two siblings in school" }))!.id;
    // Review M2: while a proposal is pending, the template's value can't change (the approver approves what was proposed).
    const tp = (await m.listConcessions(accountant)).find((c) => c.id === pct)!;
    await expect(m.updateConcession(accountant, { id: pct, version: tp.version, name: tp.name, kind: "CONCESSION", calc: "PERCENT", value: "100", categoryIds: [tui] })).rejects.toThrow(/fixed/);
    await expect(m.proposeConcession(accountant, { studentId, academicSessionId: sessionId, concessionId: pct, reason: "Again" })).rejects.toThrow(/already has this concession/);
    await expect(m.decideConcession(accountant, { id: p1, version: 1, decision: "APPROVE" })).rejects.toBeInstanceOf(m.ForbiddenError);
    // Super Admin proposes → Super Admin can't approve their own; the Principal can.
    const p2 = (await m.proposeConcession(superAdmin, { studentId, academicSessionId: sessionId, concessionId: fixed, reason: "Merit list" }))!.id;
    await expect(m.decideConcession(superAdmin, { id: p2, version: 1, decision: "APPROVE" })).rejects.toThrow(/someone else must decide/);
    await m.decideConcession(principal, { id: p1, version: 1, decision: "APPROVE" });
    await m.decideConcession(principal, { id: p2, version: 1, decision: "APPROVE" });
    await expect(m.decideConcession(principal, { id: p1, version: 2, decision: "REJECT" })).rejects.toThrow(/already been decided/);
    // FIXED is per installment (KI-102): 4 quarterly invoices × 500 = 2,000 for the session; 10 % of 12,000 = 1,200.
    const reg = await m.listStudentConcessions(principal, sessionId);
    expect(reg.find((r) => r.id === p2)?.effect).toMatchObject({ installments: 4, sessionTotal: "2000.00" });
    expect(reg.find((r) => r.id === p1)?.effect).toMatchObject({ sessionTotal: "1200.00" });
    expect(reg.find((r) => r.id === p1)?.reason).toBe("Two siblings in school");
    // Audit rows carry ids and statuses — never the reason.
    const rows = await m.prisma.auditLog.findMany({ where: { entityType: "StudentConcession", entityId: { in: [p1, p2] } }, select: { after: true } });
    expect(JSON.stringify(rows)).not.toMatch(/siblings|Merit list/);
  });

  it("an approved template's value is fixed; revoking frees the student for a new proposal", async () => {
    const [pct] = concessionIds;
    const t = (await m.listConcessions(accountant)).find((c) => c.id === pct)!;
    await expect(m.updateConcession(accountant, { id: pct, version: t.version, name: t.name, kind: "CONCESSION", calc: "PERCENT", value: "20", categoryIds: [tui] })).rejects.toThrow(/fixed/);
    await m.updateConcession(accountant, { id: pct, version: t.version, name: `${t.name} (siblings)`, kind: "CONCESSION", calc: "PERCENT", value: "10", categoryIds: [tui] });
    const approved = (await m.listStudentConcessions(accountant, sessionId, { status: "APPROVED" })).find((r) => r.concessionName.startsWith(`${run} Sibling`))!;
    await expect(m.revokeConcession(accountant, { id: approved.id, version: approved.version })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.revokeConcession(principal, { id: approved.id, version: approved.version });
    await m.proposeConcession(accountant, { studentId, academicSessionId: sessionId, concessionId: pct, reason: "Re-proposed" });
  });

  it("charges: on one installment, removable until invoiced; readers can't add; parents see nothing", async () => {
    const c = await m.addCharge(accountant, { studentId, academicSessionId: sessionId, installmentId: inst1, categoryId: tui, amount: "250.50", note: "Science club" });
    expect((await m.listCharges(principal, sessionId)).map((x) => [x.amount, x.note])).toEqual([["250.50", "Science club"]]);
    await expect(m.addCharge(principal, { studentId, academicSessionId: sessionId, installmentId: inst1, categoryId: tui, amount: "1", note: "x" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.removeCharge(accountant, { id: c!.id, version: 1 });
    expect(await m.listCharges(accountant, sessionId)).toEqual([]);
    await expect(m.listStudentConcessions(parent, sessionId)).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.searchStudentsForFees(parent, sessionId, "pupil")).rejects.toBeInstanceOf(m.ForbiddenError);
  });
});
