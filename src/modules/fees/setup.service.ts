import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { MONEY_MAX, moneyString, toMoney } from "@/lib/money";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { activeClassOptions, lockClassShared, lockSessionShared, sessionFacts, sessionOptions } from "@/modules/academic/academic.tx";
import { masterNameKeyOf } from "@/modules/hr/hr.rules";
import { sessionGeneratesInvoices } from "./fee-rules";
import { assertFeeSetupRead } from "./fees.policy";
import { lockFeeSetup } from "./fees.tx";
import type {
  CopyStructureInput,
  CreateCategoryInput,
  CreateInstallmentInput,
  CreateStructureInput,
  RefInput,
  SetActiveInput,
  SetLateFeeRuleInput,
  UpdateCategoryInput,
  UpdateInstallmentInput,
  UpdateStructureInput,
} from "./setup.schemas";

/**
 * Phase 5A-M2 — fee setup (PHASE_5_PLAN.md FC2, FC3, FC5, FC7; ADR-040).
 *
 * - School-defined only: nothing is seeded. Reads: `fee.read` ALL or `fee.structure.manage`; writes:
 *   `fee.structure.manage`. Every write takes the fee-setup advisory lock first (fees.tx), then the session FOR SHARE.
 * - Sessions: setup changes only in PLANNED / ACTIVE sessions; installment due dates inside the session.
 * - Categories: code and kind are fixed once used; deactivate, never delete. System kinds (TRANSPORT, LATE_FEE,
 *   OPENING_BALANCE) are created by the fee services themselves, never here.
 * - Installments: deleted only while nothing uses them (no structure amount, charge or invoice).
 * - Structures: one ACTIVE per (session, class) — partial unique. Review 5A-M2 M1: a structure that has EVER been
 *   active (append-only audit history) is FROZEN once its class has a live invoice in the session — deactivating it
 *   doesn't unfreeze it. Changes go through a copy that has never been active, which is then activated for future
 *   invoices. (Exact per-structure freezing needs FeeInvoice.structureId — KI-103, with the generation migration.)
 *   Items only for active, school-kind categories and the session's installments — re-checked on activate and copy
 *   (review M2). Totals fit Decimal(12,2) per installment and overall (review L4).
 * - Late fee: one active rule per session; setting a new one retires the old one (history kept).
 * Audit rows carry ids, codes, names, dates and counts — amounts only as structure totals, never per student.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const stale = (what: string) => new ConflictError(`This ${what} was changed by someone else. Reload the page and try again.`);
const MAX_ROWS = 200;
const SYSTEM_KINDS = new Set(["TRANSPORT", "LATE_FEE", "OPENING_BALANCE"]);

function mapErrors(e: unknown, what: string, input?: { code?: string; name?: string }): never {
  if (input?.code && isUniqueViolation(e, "code")) throw new ConflictError(`A ${what} with code ${input.code} already exists.`);
  if (input?.name && isUniqueViolation(e, "nameKey")) throw new ConflictError(`A ${what} named "${input.name}" already exists.`);
  if (isUniqueViolation(e)) throw new ConflictError(`That ${what} already exists or was changed meanwhile. Reload the page and try again.`);
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}

/** Setup lock, then the session FOR SHARE; refuses CLOSED sessions. */
async function lockWritableSession(tx: Tx, sessionId: string) {
  await lockFeeSetup(tx);
  const status = await lockSessionShared(tx, sessionId);
  if (!sessionGeneratesInvoices(status)) throw new ConflictError("This academic session is closed; its fee setup can't change.");
  return sessionFacts(tx, sessionId);
}

// ───────────────────────────── Options for the screens ─────────────────────────────

export async function feeSetupOptions(ctx: AuthContext) {
  assertFeeSetupRead(ctx);
  const [sessions, classes] = await Promise.all([sessionOptions(prisma), activeClassOptions(prisma)]);
  return { sessions: sessions.map((s) => ({ ...s, startDate: iso(s.startDate), endDate: iso(s.endDate) })), classes };
}

// ───────────────────────────── Categories ─────────────────────────────

const CATEGORY_SELECT = { id: true, code: true, name: true, kind: true, appliesTo: true, isActive: true, version: true } as const;

export async function listFeeCategories(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  assertFeeSetupRead(ctx);
  const rows = await prisma.feeCategory.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...CATEGORY_SELECT, _count: { select: { structureItems: true, invoiceItems: true } } },
  });
  return rows.map(({ _count, ...c }) => ({ ...c, used: _count.structureItems + _count.invoiceItems > 0, system: SYSTEM_KINDS.has(c.kind) }));
}

export async function createFeeCategory(ctx: AuthContext, input: CreateCategoryInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const c = await tx.feeCategory.create({ data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, appliesTo: input.appliesTo }, select: CATEGORY_SELECT });
      await audit(tx, actorOf(ctx), { action: "fee_category.create", entityType: "FeeCategory", entityId: c.id, after: { code: c.code, name: c.name, kind: c.kind, appliesTo: c.appliesTo } });
      return c;
    });
  } catch (e) {
    mapErrors(e, "fee head", input);
  }
}

async function lockCategory(tx: Tx, id: string, version: number) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_category WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Fee head not found.");
  const c = await tx.feeCategory.findUniqueOrThrow({ where: { id }, select: CATEGORY_SELECT });
  if (c.version !== version) throw stale("fee head");
  if (SYSTEM_KINDS.has(c.kind)) throw new ConflictError("This fee head is managed by the system.");
  return c;
}

export async function updateFeeCategory(ctx: AuthContext, input: UpdateCategoryInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const c = await lockCategory(tx, input.id, input.version);
      if (c.name === input.name && c.appliesTo === input.appliesTo) return;
      await tx.feeCategory.update({ where: { id: c.id }, data: { name: input.name, nameKey: masterNameKeyOf(input.name), appliesTo: input.appliesTo, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_category.update", entityType: "FeeCategory", entityId: c.id, before: { name: c.name, appliesTo: c.appliesTo }, after: { name: input.name, appliesTo: input.appliesTo } });
    });
  } catch (e) {
    mapErrors(e, "fee head", { name: input.name });
  }
}

export async function setFeeCategoryActive(ctx: AuthContext, input: SetActiveInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const c = await lockCategory(tx, input.id, input.version);
      if (c.isActive === input.active) return;
      if (!input.active) {
        const inActive = await tx.feeStructureItem.count({ where: { categoryId: c.id, structure: { isActive: true, academicSession: { status: { not: "CLOSED" } } } } }); // review L5
        if (inActive > 0) throw new ConflictError("An active fee structure uses this fee head. Remove it there first (copy the structure if it is already in use).");
      }
      await tx.feeCategory.update({ where: { id: c.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_category.status_change", entityType: "FeeCategory", entityId: c.id, before: { isActive: c.isActive }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "fee head");
  }
}

// ───────────────────────────── Installments ─────────────────────────────

const INSTALLMENT_SELECT = { id: true, academicSessionId: true, name: true, dueOn: true, sortOrder: true, version: true } as const;

export async function listFeeInstallments(ctx: AuthContext, academicSessionId: string) {
  assertFeeSetupRead(ctx);
  const rows = await prisma.feeInstallment.findMany({
    where: { academicSessionId },
    orderBy: [{ dueOn: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { ...INSTALLMENT_SELECT, _count: { select: { structureItems: true, charges: true, invoices: true } } },
  });
  return rows.map(({ _count, ...i }) => ({ ...i, dueOn: iso(i.dueOn), used: _count.structureItems + _count.charges + _count.invoices > 0, invoiced: _count.invoices > 0 }));
}

function assertDueInSession(dueOn: string, s: { name: string; startDate: Date; endDate: Date }) {
  if (dueOn < iso(s.startDate) || dueOn > iso(s.endDate)) {
    const message = `The due date must be inside ${s.name} (${iso(s.startDate)} to ${iso(s.endDate)}).`;
    throw new ValidationError(message, [{ path: "dueOn", message }]);
  }
}

export async function createFeeInstallment(ctx: AuthContext, input: CreateInstallmentInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const s = await lockWritableSession(tx, input.academicSessionId);
      assertDueInSession(input.dueOn, s);
      const count = await tx.feeInstallment.count({ where: { academicSessionId: s.id } });
      if (count >= 60) throw new ConflictError("A session has at most 60 installments.");
      const i = await tx.feeInstallment.create({
        data: { academicSessionId: s.id, name: input.name, nameKey: masterNameKeyOf(input.name), dueOn: day(input.dueOn), sortOrder: input.sortOrder },
        select: { id: true },
      });
      await audit(tx, actorOf(ctx), { action: "fee_installment.create", entityType: "FeeInstallment", entityId: i.id, after: { academicSessionId: s.id, name: input.name, dueOn: input.dueOn } });
      return i;
    });
  } catch (e) {
    mapErrors(e, "installment", { name: input.name });
  }
}

async function lockInstallment(tx: Tx, id: string, version: number) {
  const peek = await tx.feeInstallment.findUnique({ where: { id }, select: { academicSessionId: true } });
  if (!peek) throw new NotFoundError("Installment not found.");
  const s = await lockWritableSession(tx, peek.academicSessionId);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_installment WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Installment not found.");
  const i = await tx.feeInstallment.findUniqueOrThrow({ where: { id }, select: INSTALLMENT_SELECT });
  if (i.version !== version) throw stale("installment");
  return { i, s };
}

/** Name, order and due date. Issued invoices keep their own due-date snapshot, so a later edit never moves them. */
export async function updateFeeInstallment(ctx: AuthContext, input: UpdateInstallmentInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const { i, s } = await lockInstallment(tx, input.id, input.version);
      assertDueInSession(input.dueOn, s);
      if (i.name === input.name && iso(i.dueOn) === input.dueOn && i.sortOrder === input.sortOrder) return;
      await tx.feeInstallment.update({ where: { id: i.id }, data: { name: input.name, nameKey: masterNameKeyOf(input.name), dueOn: day(input.dueOn), sortOrder: input.sortOrder, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_installment.update", entityType: "FeeInstallment", entityId: i.id, before: { name: i.name, dueOn: iso(i.dueOn) }, after: { name: input.name, dueOn: input.dueOn } });
    });
  } catch (e) {
    mapErrors(e, "installment", { name: input.name });
  }
}

export async function deleteFeeInstallment(ctx: AuthContext, input: RefInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const { i } = await lockInstallment(tx, input.id, input.version);
      const [items, charges, invoices] = await Promise.all([
        tx.feeStructureItem.count({ where: { installmentId: i.id } }),
        tx.studentFeeCharge.count({ where: { installmentId: i.id } }),
        tx.feeInvoice.count({ where: { installmentId: i.id } }),
      ]);
      if (items + charges + invoices > 0) throw new ConflictError("This installment is used by a fee structure, a charge or an invoice, so it can't be deleted.");
      await tx.feeInstallment.delete({ where: { id: i.id } });
      await audit(tx, actorOf(ctx), { action: "fee_installment.delete", entityType: "FeeInstallment", entityId: i.id, before: { name: i.name, dueOn: iso(i.dueOn) } });
    });
  } catch (e) {
    mapErrors(e, "installment");
  }
}

// ───────────────────────────── Structures ─────────────────────────────

/** Live invoices of the class in the session. */
async function classInvoiceCount(db: Tx | typeof prisma, academicSessionId: string, classId: string) {
  return db.feeInvoice.count({ where: { academicSessionId, kind: "INSTALLMENT", deletedAt: null, enrollment: { section: { classId } } } });
}

/** Has this structure ever been active? Read from the append-only audit rows (created active, or activated). */
async function everActive(db: Tx | typeof prisma, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.auditLog.findMany({
    where: { entityType: "FeeStructure", entityId: { in: ids }, action: { in: ["fee_structure.create", "fee_structure.status_change"] }, after: { path: ["isActive"], equals: true } },
    select: { entityId: true },
    distinct: ["entityId"],
  });
  return new Set(rows.map((r) => r.entityId).filter((x): x is string => x !== null));
}

/** Review M1: frozen = ever active AND the class has live invoices in the session. */
async function isFrozen(db: Tx | typeof prisma, st: { id: string; isActive: boolean; academicSessionId: string; classId: string }) {
  if ((await classInvoiceCount(db, st.academicSessionId, st.classId)) === 0) return false;
  return st.isActive || (await everActive(db, [st.id])).has(st.id);
}

export async function listFeeStructures(ctx: AuthContext, academicSessionId: string) {
  assertFeeSetupRead(ctx);
  const rows = await prisma.feeStructure.findMany({
    where: { academicSessionId },
    orderBy: [{ class: { displayOrder: "asc" } }, { isActive: "desc" }, { createdAt: "asc" }],
    take: MAX_ROWS,
    select: {
      id: true,
      name: true,
      classId: true,
      isActive: true,
      version: true,
      class: { select: { name: true, code: true } },
      items: { select: { categoryId: true, installmentId: true, amount: true }, take: 400 },
    },
  });
  const invoiced = new Map<string, number>();
  for (const classId of new Set(rows.map((r) => r.classId))) invoiced.set(classId, await classInvoiceCount(prisma, academicSessionId, classId));
  const wasActive = await everActive(prisma, rows.filter((r) => (invoiced.get(r.classId) ?? 0) > 0 && !r.isActive).map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    classId: r.classId,
    className: r.class.name,
    isActive: r.isActive,
    version: r.version,
    frozen: (invoiced.get(r.classId) ?? 0) > 0 && (r.isActive || wasActive.has(r.id)),
    items: r.items.map((i) => ({ categoryId: i.categoryId, installmentId: i.installmentId, amount: moneyString(i.amount.toString()) })),
    total: moneyString(r.items.reduce((a, i) => a.plus(i.amount.toString()), toMoney("0"))),
  }));
}

async function checkItems(tx: Tx, academicSessionId: string, items: readonly { categoryId: string; installmentId: string; amount: string }[]) {
  const [cats, insts] = await Promise.all([
    tx.feeCategory.findMany({ where: { id: { in: [...new Set(items.map((i) => i.categoryId))] } }, select: { id: true, name: true, kind: true, isActive: true } }),
    tx.feeInstallment.findMany({ where: { id: { in: [...new Set(items.map((i) => i.installmentId))] }, academicSessionId }, select: { id: true } }),
  ]);
  const cat = new Map(cats.map((c) => [c.id, c]));
  const inst = new Set(insts.map((i) => i.id));
  for (const it of items) {
    const c = cat.get(it.categoryId);
    if (!c || !c.isActive) throw new ValidationError("A fee head is unknown or inactive. Reload the page.", [{ path: "items", message: "Unknown or inactive fee head." }]);
    if (SYSTEM_KINDS.has(c.kind)) throw new ValidationError(`${c.name} can't be part of a class fee structure.`, [{ path: "items", message: "System fee head." }]);
    if (!inst.has(it.installmentId)) throw new ValidationError("An installment isn't part of this session. Reload the page.", [{ path: "items", message: "Unknown installment." }]);
  }
  const total = items.reduce((a, i) => a.plus(i.amount), toMoney("0"));
  if (total.lte(0)) throw new ValidationError("Enter at least one amount above zero.", [{ path: "items", message: "All amounts are zero." }]);
  // Review L4: every invoice total (per installment) and the session total must fit Decimal(12,2).
  const perInstallment = new Map<string, ReturnType<typeof toMoney>>();
  for (const i of items) perInstallment.set(i.installmentId, (perInstallment.get(i.installmentId) ?? toMoney("0")).plus(i.amount));
  if (total.gt(MONEY_MAX) || [...perInstallment.values()].some((v) => v.gt(MONEY_MAX))) throw new ValidationError("The amounts are too large.", [{ path: "items", message: "Too large." }]);
  return moneyString(total);
}

export async function createFeeStructure(ctx: AuthContext, input: CreateStructureInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const s = await lockWritableSession(tx, input.academicSessionId);
      const cls = await lockClassShared(tx, input.classId);
      if (!cls.isActive) throw new ConflictError("This class is inactive.");
      const total = await checkItems(tx, s.id, input.items);
      const hasActive = (await tx.feeStructure.count({ where: { academicSessionId: s.id, classId: cls.id, isActive: true } })) > 0;
      const st = await tx.feeStructure.create({ data: { academicSessionId: s.id, classId: cls.id, name: input.name, isActive: !hasActive }, select: { id: true, isActive: true } });
      await tx.feeStructureItem.createMany({ data: input.items.map((i) => ({ structureId: st.id, academicSessionId: s.id, categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount })) });
      await audit(tx, actorOf(ctx), { action: "fee_structure.create", entityType: "FeeStructure", entityId: st.id, after: { academicSessionId: s.id, classId: cls.id, name: input.name, items: input.items.length, total, isActive: st.isActive } });
      return st;
    });
  } catch (e) {
    mapErrors(e, "fee structure");
  }
}

async function lockStructure(tx: Tx, id: string, version?: number) {
  const peek = await tx.feeStructure.findUnique({ where: { id }, select: { academicSessionId: true } });
  if (!peek) throw new NotFoundError("Fee structure not found.");
  await lockWritableSession(tx, peek.academicSessionId);
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_structure WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Fee structure not found.");
  const st = await tx.feeStructure.findUniqueOrThrow({ where: { id }, select: { id: true, academicSessionId: true, classId: true, name: true, isActive: true, version: true, items: { select: { categoryId: true, installmentId: true, amount: true } } } });
  if (version !== undefined && st.version !== version) throw stale("fee structure");
  return st;
}

export async function updateFeeStructure(ctx: AuthContext, input: UpdateStructureInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const st = await lockStructure(tx, input.id, input.version);
      if (await isFrozen(tx, st)) {
        throw new ConflictError("Invoices were issued with this structure, so its amounts are fixed. Copy it, change the copy and make the copy active for future invoices.");
      }
      const total = await checkItems(tx, st.academicSessionId, input.items);
      await tx.feeStructureItem.deleteMany({ where: { structureId: st.id } });
      await tx.feeStructureItem.createMany({ data: input.items.map((i) => ({ structureId: st.id, academicSessionId: st.academicSessionId, categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount })) });
      await tx.feeStructure.update({ where: { id: st.id }, data: { name: input.name, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_structure.update", entityType: "FeeStructure", entityId: st.id, before: { name: st.name, items: st.items.length }, after: { name: input.name, items: input.items.length, total } });
    });
  } catch (e) {
    mapErrors(e, "fee structure");
  }
}

/** A new, inactive structure with the same amounts (the way to change a frozen one). */
export async function copyFeeStructure(ctx: AuthContext, input: CopyStructureInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      const st = await lockStructure(tx, input.id);
      await checkItems(tx, st.academicSessionId, st.items.map((i) => ({ categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount.toString() }))); // review M2
      const copy = await tx.feeStructure.create({ data: { academicSessionId: st.academicSessionId, classId: st.classId, name: input.name, isActive: false }, select: { id: true } });
      await tx.feeStructureItem.createMany({ data: st.items.map((i) => ({ structureId: copy.id, academicSessionId: st.academicSessionId, categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount })) });
      await audit(tx, actorOf(ctx), { action: "fee_structure.copy", entityType: "FeeStructure", entityId: copy.id, after: { fromStructureId: st.id, name: input.name, items: st.items.length } });
      return copy;
    });
  } catch (e) {
    mapErrors(e, "fee structure");
  }
}

/** Activate (the class's current active structure is deactivated in the same transaction) or deactivate. */
export async function setFeeStructureActive(ctx: AuthContext, input: SetActiveInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const st = await lockStructure(tx, input.id, input.version);
      if (st.isActive === input.active) return;
      let replaced: string | null = null;
      if (input.active) {
        if (st.items.length === 0) throw new ConflictError("Add amounts before making this structure active.");
        // Review M2: a fee head deactivated meanwhile can't come back into billing through an old structure.
        await checkItems(tx, st.academicSessionId, st.items.map((i) => ({ categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount.toString() })));
        const cur = await tx.feeStructure.findFirst({ where: { academicSessionId: st.academicSessionId, classId: st.classId, isActive: true }, select: { id: true } });
        if (cur) {
          await tx.feeStructure.update({ where: { id: cur.id }, data: { isActive: false, version: { increment: 1 } } });
          replaced = cur.id;
        }
      }
      await tx.feeStructure.update({ where: { id: st.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_structure.status_change", entityType: "FeeStructure", entityId: st.id, before: { isActive: st.isActive }, after: { isActive: input.active, ...(replaced ? { replacedStructureId: replaced } : {}) } });
    });
  } catch (e) {
    mapErrors(e, "fee structure");
  }
}

// ───────────────────────────── Late fee ─────────────────────────────

export async function getLateFeeRule(ctx: AuthContext, academicSessionId: string) {
  assertFeeSetupRead(ctx);
  const r = await prisma.lateFeeRule.findFirst({ where: { academicSessionId, isActive: true }, select: { id: true, graceDays: true, calc: true, value: true, cap: true } });
  return r ? { ...r, value: moneyString(r.value.toString()), cap: r.cap === null ? null : moneyString(r.cap.toString()) } : null;
}

export async function setLateFeeRule(ctx: AuthContext, input: SetLateFeeRuleInput) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const s = await lockWritableSession(tx, input.academicSessionId);
      const old = await tx.lateFeeRule.findFirst({ where: { academicSessionId: s.id, isActive: true }, select: { id: true } });
      if (old) await tx.lateFeeRule.update({ where: { id: old.id }, data: { isActive: false, version: { increment: 1 } } });
      const r = await tx.lateFeeRule.create({ data: { academicSessionId: s.id, graceDays: input.graceDays, calc: input.calc, value: input.value, cap: input.cap }, select: { id: true } });
      await audit(tx, actorOf(ctx), { action: "late_fee_rule.set", entityType: "LateFeeRule", entityId: r.id, after: { academicSessionId: s.id, graceDays: input.graceDays, calc: input.calc, value: input.value, cap: input.cap, ...(old ? { replacedRuleId: old.id } : {}) } });
    });
  } catch (e) {
    mapErrors(e, "late fee rule");
  }
}

export async function clearLateFeeRule(ctx: AuthContext, academicSessionId: string) {
  authorize(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      const s = await lockWritableSession(tx, academicSessionId);
      const old = await tx.lateFeeRule.findFirst({ where: { academicSessionId: s.id, isActive: true }, select: { id: true } });
      if (!old) return;
      await tx.lateFeeRule.update({ where: { id: old.id }, data: { isActive: false, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "late_fee_rule.clear", entityType: "LateFeeRule", entityId: old.id, after: { academicSessionId: s.id } });
    });
  } catch (e) {
    mapErrors(e, "late fee rule");
  }
}

