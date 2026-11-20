import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 5A-M2 fee setup against real Postgres (Neon Test branch only, behind the S-05 target guard; skipped without
 * TEST_DATABASE_URL). Fee heads, installments inside the session, class structures (one active, copy → activate,
 * the freeze-after-invoicing rule is tested with invoice generation in 5A-M4), late-fee rule history, closed sessions refused, read vs manage roles, audit without amounts
 * per student. Synthetic data in a far-future session; removed in afterAll except audit rows (append-only, S-07).
 * Needs migration 20261124000000 on the Test branch.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/modules/fees/setup.service")),
  ...(await import("@/modules/settings/settings.service")),
});
const m = enabled ? await load() : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("fee setup (integration)", () => {
  const run = `fs${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  const Y = 2100 + Math.floor(Math.random() * 700);
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let accountant: Ctx, principal: Ctx, teacher: Ctx, parent: Ctx;
  let sessionId: string, closedId: string, classId: string;
  const categoryIds: string[] = [];

  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
    return m.prisma.user.create({ data: { username: `${run}-${suffix}`, displayName: `Synthetic ${suffix}`, passwordHash: "x", roles: { create: { roleId: role.id } } } });
  }
  const login = async (id: string) => (await m.validateSessionToken((await m.createSession(id, { long: false })).token))!;

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    accountant = await login((await user("acc", "ACCOUNTANT")).id);
    principal = await login((await user("prin", "PRINCIPAL")).id);
    teacher = await login((await user("t", "TEACHER")).id);
    parent = await login((await user("par", "PARENT")).id);
    sessionId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y}`, startDate: d(`${Y}-04-01`), endDate: d(`${Y + 1}-03-31`), status: "ACTIVE" } })).id;
    closedId = (await m.prisma.academicSession.create({ data: { name: `${run}-${Y - 1}`, startDate: d(`${Y - 1}-04-01`), endDate: d(`${Y}-03-31`), status: "CLOSED" } })).id;
    classId = (await m.prisma.schoolClass.create({ data: { code: `${tag}C6`, name: `${run} six`, nameKey: `${run} six`, numericLevel: 6 } })).id;
  }, 120_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    const sessions = [sessionId, closedId].filter(Boolean);
    await prisma.lateFeeRule.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.feeStructure.deleteMany({ where: { academicSessionId: { in: sessions } } }); // items cascade
    await prisma.feeInstallment.deleteMany({ where: { academicSessionId: { in: sessions } } });
    await prisma.feeCategory.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma.schoolClass.deleteMany({ where: { code: { startsWith: tag } } });
    await prisma.academicSession.deleteMany({ where: { id: { in: sessions } } });
    await prisma.user.deleteMany({ where: { username: { startsWith: run } } });
    await prisma.$disconnect();
  }, 120_000);

  it("fee heads: school-defined, unique code and name, readers can't write", async () => {
    const tui = await m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Tuition`, kind: "REGULAR", appliesTo: "ALL" });
    const adm = await m.createFeeCategory(accountant, { code: `${tag}ADM`, name: `${run} Admission`, kind: "ONE_TIME", appliesTo: "NEW_ADMISSION" });
    categoryIds.push(tui!.id, adm!.id);
    await expect(m.createFeeCategory(accountant, { code: `${tag}TUI`, name: `${run} Other`, kind: "REGULAR", appliesTo: "ALL" })).rejects.toThrow(/already exists/);
    await expect(m.createFeeCategory(accountant, { code: `${tag}TU2`, name: `${run} TUITION`, kind: "REGULAR", appliesTo: "ALL" })).rejects.toThrow(/already exists/);
    expect((await m.listFeeCategories(principal)).some((c) => c.id === tui!.id)).toBe(true);
    await expect(m.createFeeCategory(principal, { code: `${tag}X`, name: "x", kind: "REGULAR", appliesTo: "ALL" })).rejects.toBeInstanceOf(m.ForbiddenError);
    await expect(m.listFeeCategories(teacher)).rejects.toBeInstanceOf(m.ForbiddenError);
    // fee.read at CHILDREN (Parent) is refused until the portal (FC17).
    await expect(m.listFeeCategories(parent)).rejects.toBeInstanceOf(m.ForbiddenError);
  });

  it("number formats (FC12): Accountant sets them, others are refused; audit holds only the formats", async () => {
    for (const ctx of [teacher, parent]) {
      await expect(m.getFeeNumberFormats(ctx)).rejects.toBeInstanceOf(m.ForbiddenError);
      await expect(m.updateFeeNumberFormats(ctx, { feeReceipt: "R/{SEQ:5}", feeInvoice: "I/{SEQ:5}" })).rejects.toBeInstanceOf(m.ForbiddenError);
    }
    await expect(m.updateFeeNumberFormats(accountant, { feeReceipt: "R/{SESSION}/{SEQ}", feeInvoice: "I/{SEQ}" })).rejects.toBeInstanceOf(m.ValidationError);
    const before = await m.getFeeNumberFormats(accountant);
    await m.updateFeeNumberFormats(accountant, { feeReceipt: `R${tag}/{YYYY}/{SEQ:5}`, feeInvoice: `I${tag}/{SEQ:5}` });
    expect(await m.getFeeNumberFormats(accountant)).toMatchObject({ feeReceipt: `R${tag}/{YYYY}/{SEQ:5}`, feeInvoice: `I${tag}/{SEQ:5}` });
    const row = await m.prisma.auditLog.findFirst({ where: { actorId: accountant.userId, action: "settings.fee_number_formats_update" }, select: { after: true } });
    expect(Object.keys((row?.after ?? {}) as object).sort()).toEqual(["feeInvoice", "feeReceipt"]);
    // Put the shared Test settings back as they were.
    if (before.feeReceipt && before.feeInvoice) await m.updateFeeNumberFormats(accountant, { feeReceipt: before.feeReceipt, feeInvoice: before.feeInvoice });
    else {
      const s = await m.prisma.schoolSetting.findUniqueOrThrow({ where: { id: "default" }, select: { idFormats: true } });
      const f = { ...((s.idFormats ?? {}) as Record<string, unknown>) };
      delete f.feeReceipt;
      delete f.feeInvoice;
      await m.prisma.schoolSetting.update({ where: { id: "default" }, data: { idFormats: f as object } });
    }
  });

  it("installments: due inside the session; closed sessions refused; deleted only while unused", async () => {
    await expect(m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Too early", dueOn: `${Y}-03-31`, sortOrder: 0 })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.createFeeInstallment(accountant, { academicSessionId: closedId, name: "April", dueOn: `${Y - 1}-04-10`, sortOrder: 0 })).rejects.toThrow(/closed/);
    await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "April", dueOn: `${Y}-04-10`, sortOrder: 0 });
    await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "October", dueOn: `${Y}-10-10`, sortOrder: 1 });
    await expect(m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "april", dueOn: `${Y}-05-10`, sortOrder: 2 })).rejects.toThrow(/already exists/);
    const spare = await m.createFeeInstallment(accountant, { academicSessionId: sessionId, name: "Spare", dueOn: `${Y}-12-10`, sortOrder: 3 });
    await m.deleteFeeInstallment(accountant, { id: spare!.id, version: 1 });
    expect((await m.listFeeInstallments(accountant, sessionId)).map((i) => i.name)).toEqual(["April", "October"]);
  });

  it("structures: one active per class; copy → activate switches; items checked; heads in use stay active", async () => {
    const [apr, oct] = await m.listFeeInstallments(accountant, sessionId);
    const [tui, adm] = categoryIds;
    const items = [
      { categoryId: tui, installmentId: apr.id, amount: "12000.00" },
      { categoryId: tui, installmentId: oct.id, amount: "12000.00" },
      { categoryId: adm, installmentId: apr.id, amount: "5000.50" },
    ];
    const a = await m.createFeeStructure(accountant, { academicSessionId: sessionId, classId, name: "Six A", items });
    expect(a!.isActive).toBe(true);
    const b = await m.createFeeStructure(accountant, { academicSessionId: sessionId, classId, name: "Six B", items: items.slice(0, 2) });
    expect(b!.isActive).toBe(false);
    let list = await m.listFeeStructures(principal, sessionId);
    expect(list.find((s) => s.id === a!.id)).toMatchObject({ total: "29000.50", isActive: true, frozen: false });
    // Items must be the session's installments and active school heads.
    await expect(m.updateFeeStructure(accountant, { id: a!.id, version: 1, name: "Six A", items: [{ categoryId: tui, installmentId: "nope000000", amount: "1" }] })).rejects.toBeInstanceOf(m.ValidationError);
    await m.setFeeStructureActive(accountant, { id: b!.id, version: 1, active: true });
    list = await m.listFeeStructures(accountant, sessionId);
    expect(list.filter((s) => s.isActive).map((s) => s.id)).toEqual([b!.id]);
    const copy = await m.copyFeeStructure(accountant, { id: a!.id, name: "Six A (new)" });
    expect((await m.listFeeStructures(accountant, sessionId)).find((s) => s.id === copy!.id)).toMatchObject({ isActive: false, total: "29000.50" });
    // The heads used by an active structure can't be deactivated.
    const cat = (await m.listFeeCategories(accountant)).find((c) => c.id === tui)!;
    await expect(m.setFeeCategoryActive(accountant, { id: tui, version: cat.version, active: false })).rejects.toThrow(/active fee structure uses/);
    // Review M2: a head deactivated meanwhile can't come back through an old structure (activate or copy).
    const admCat = (await m.listFeeCategories(accountant)).find((c) => c.id === adm)!;
    await m.setFeeCategoryActive(accountant, { id: adm, version: admCat.version, active: false }); // only inactive structures use it
    const aNow = (await m.listFeeStructures(accountant, sessionId)).find((s) => s.id === a!.id)!;
    await expect(m.setFeeStructureActive(accountant, { id: a!.id, version: aNow.version, active: true })).rejects.toBeInstanceOf(m.ValidationError);
    await expect(m.copyFeeStructure(accountant, { id: a!.id, name: "Six A again" })).rejects.toBeInstanceOf(m.ValidationError);
  });

  it("late fee: one active rule; a new rule retires the old one; clearing turns it off", async () => {
    await expect(m.setLateFeeRule(accountant, { academicSessionId: sessionId, graceDays: 5, calc: "PER_DAY", value: "10", cap: null })).rejects.toThrow();
    await m.setLateFeeRule(accountant, { academicSessionId: sessionId, graceDays: 5, calc: "FLAT", value: "100", cap: null });
    await m.setLateFeeRule(accountant, { academicSessionId: sessionId, graceDays: 7, calc: "PER_DAY", value: "10", cap: "300" });
    expect(await m.getLateFeeRule(principal, sessionId)).toMatchObject({ graceDays: 7, calc: "PER_DAY", value: "10.00", cap: "300.00" });
    expect(await m.prisma.lateFeeRule.count({ where: { academicSessionId: sessionId } })).toBe(2);
    await m.clearLateFeeRule(accountant, sessionId);
    expect(await m.getLateFeeRule(accountant, sessionId)).toBeNull();
    // Audit rows hold ids and rule values, never per-student data.
    const rows = await m.prisma.auditLog.findMany({ where: { actorId: accountant.userId, action: { startsWith: "late_fee_rule" } }, select: { action: true } });
    expect(rows.map((r) => r.action).sort()).toEqual(["late_fee_rule.clear", "late_fee_rule.set", "late_fee_rule.set"]);
  });
});
