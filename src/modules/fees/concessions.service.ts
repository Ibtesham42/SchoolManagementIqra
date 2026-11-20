import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { ConflictError, ForbiddenError, NotFoundError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { moneyString, sumMoney } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { lockSessionShared } from "@/modules/academic/academic.tx";
import { masterNameKeyOf } from "@/modules/hr/hr.rules";
import { enrollmentSummary, searchEnrollments, type EnrollmentSummary } from "@/modules/students/enrollment-reads.tx";
import { priceLines, type ConcessionInput } from "./fee-calc";
import { billableInstallments, itemApplies, sessionGeneratesInvoices } from "./fee-rules";
import { authorizeFeeWrite, canReadFees, holdsAll } from "./fees.policy";
import { lockFeeSetup } from "./fees.tx";
import type { AddChargeInput, ConcessionRefInput, CreateConcessionInput, DecideConcessionInput, ProposeConcessionInput, UpdateConcessionInput } from "./concessions.schemas";

/**
 * Phase 5A-M3 — concessions and scholarships (FC6, maker-checker) and per-student charges (FC18).
 *
 * - Templates: read by fee readers (ALL) and concession staff; written with `fee.concession.manage`. A template's
 *   calculation, value and fee heads are FIXED once a PROPOSED or approved student concession uses it (review 5A-M3 M2:
 *   the approver approves exactly what was proposed); its name can change; deactivate, never delete.
 * - Every write right counts at ALL scope only (review M1, fees.policy.authorizeFeeWrite).
 * - Student concessions: PROPOSED with `fee.concession.manage` → APPROVED / REJECTED with `fee.concession.approve` by a
 *   DIFFERENT person (Super Admin included; review 5A L5: a proposal whose proposer is unknown is decided only by a
 *   Super Admin). An APPROVED concession can be REVOKED by an approver. One live (PROPOSED / APPROVED) row per
 *   enrollment and template (partial unique). Only for PLANNED / ACTIVE sessions.
 * - FIXED values are per invoice (per installment — KI-102): every list shows the per-installment amount AND the
 *   session total worked out from the class's active fee structure, so the approver sees the real yearly effect.
 * - The reason is personal-tier text (review 5A I4): returned only to concession managers / approvers, never audited.
 * - Charges: `fee.structure.manage`; MANUAL extras on one installment for one enrollment; removable until invoiced.
 * Writes take the fee-setup lock first (invoice generation reads concessions and charges under the same lock).
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const stale = (what: string) => new ConflictError(`This ${what} was changed by someone else. Reload the page and try again.`);
const MAX_ROWS = 200;
const SYSTEM_KINDS = new Set(["TRANSPORT", "LATE_FEE", "OPENING_BALANCE"]);

function mapErrors(e: unknown, what: string, input?: { code?: string; name?: string }): never {
  if (input?.code && isUniqueViolation(e, "code")) throw new ConflictError(`A ${what} with code ${input.code} already exists.`);
  if (input?.name && isUniqueViolation(e, "nameKey")) throw new ConflictError(`A ${what} named "${input.name}" already exists.`);
  if (isUniqueViolation(e)) throw new ConflictError("This student already has this concession (proposed or approved).");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  throw e;
}

const canManage = (ctx: AuthContext) => holdsAll(ctx, "fee.concession.manage");
const canApprove = (ctx: AuthContext) => holdsAll(ctx, "fee.concession.approve");
const seesReasons = (ctx: AuthContext) => canManage(ctx) || canApprove(ctx);
function assertConcessionRead(ctx: AuthContext) {
  if (!canReadFees(ctx) && !seesReasons(ctx)) throw new ForbiddenError();
}

async function writableSession(tx: Tx, academicSessionId: string) {
  const status = await lockSessionShared(tx, academicSessionId);
  if (!sessionGeneratesInvoices(status)) throw new ConflictError("This academic session is closed.");
}

// ───────────────────────────── Templates ─────────────────────────────

export async function listConcessions(ctx: AuthContext, opts: { includeInactive?: boolean } = {}) {
  assertConcessionRead(ctx);
  const rows = await prisma.feeConcession.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: [{ isActive: "desc" }, { name: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: { id: true, code: true, name: true, kind: true, calc: true, value: true, isActive: true, version: true, categories: { select: { categoryId: true, category: { select: { name: true } } } }, _count: { select: { students: { where: { status: { in: ["PROPOSED", "APPROVED"] } } } } } },
  });
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    calc: r.calc,
    value: moneyString(r.value.toString()),
    isActive: r.isActive,
    version: r.version,
    categoryIds: r.categories.map((c) => c.categoryId),
    categoryNames: r.categories.map((c) => c.category.name),
    inUse: r._count.students > 0,
  }));
}

async function checkHeads(tx: Tx, ids: readonly string[]) {
  const cats = await tx.feeCategory.findMany({ where: { id: { in: [...ids] } }, select: { id: true, kind: true, isActive: true } });
  if (cats.length !== ids.length || cats.some((c) => !c.isActive || SYSTEM_KINDS.has(c.kind))) {
    throw new ValidationError("Choose active fee heads only (not late fee, transport or previous dues).", [{ path: "categoryIds", message: "Unknown or system fee head." }]);
  }
}

export async function createConcession(ctx: AuthContext, input: CreateConcessionInput) {
  authorizeFeeWrite(ctx, "fee.concession.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      await checkHeads(tx, input.categoryIds);
      const c = await tx.feeConcession.create({
        data: { code: input.code, name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, calc: input.calc, value: input.value, categories: { create: input.categoryIds.map((categoryId) => ({ categoryId })) } },
        select: { id: true },
      });
      await audit(tx, actorOf(ctx), { action: "fee_concession.create", entityType: "FeeConcession", entityId: c.id, after: { code: input.code, name: input.name, kind: input.kind, calc: input.calc, value: input.value, categories: input.categoryIds.length } });
      return c;
    });
  } catch (e) {
    mapErrors(e, "concession", input);
  }
}

async function lockConcession(tx: Tx, id: string, version: number) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_concession WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Concession not found.");
  const c = await tx.feeConcession.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, calc: true, value: true, isActive: true, version: true, categories: { select: { categoryId: true } } } });
  if (c.version !== version) throw stale("concession");
  return c;
}

export async function updateConcession(ctx: AuthContext, input: UpdateConcessionInput) {
  authorizeFeeWrite(ctx, "fee.concession.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const c = await lockConcession(tx, input.id, input.version);
      const sameHeads = [...c.categories.map((x) => x.categoryId)].sort().join() === [...input.categoryIds].sort().join();
      const sameMoney = c.calc === input.calc && moneyString(c.value.toString()) === moneyString(input.value) && sameHeads;
      // Review 5A-M3 M2: frozen while any proposal is pending too — the approver must approve exactly what they saw.
      if (!sameMoney && (await tx.studentConcession.count({ where: { concessionId: c.id, status: { in: ["PROPOSED", "APPROVED"] } } })) > 0) {
        throw new ConflictError("Proposed or approved concessions use this template, so its value and fee heads are fixed (only the name can change). Create a new template instead.");
      }
      if (!sameHeads) await checkHeads(tx, input.categoryIds);
      if (sameMoney && c.name === input.name) return;
      await tx.feeConcession.update({ where: { id: c.id }, data: { name: input.name, nameKey: masterNameKeyOf(input.name), kind: input.kind, calc: input.calc, value: input.value, version: { increment: 1 } } });
      if (!sameHeads) {
        await tx.feeConcessionCategory.deleteMany({ where: { concessionId: c.id } });
        await tx.feeConcessionCategory.createMany({ data: input.categoryIds.map((categoryId) => ({ concessionId: c.id, categoryId })) });
      }
      await audit(tx, actorOf(ctx), { action: "fee_concession.update", entityType: "FeeConcession", entityId: c.id, before: { name: c.name, calc: c.calc, value: moneyString(c.value.toString()) }, after: { name: input.name, calc: input.calc, value: input.value, categories: input.categoryIds.length } });
    });
  } catch (e) {
    mapErrors(e, "concession", { name: input.name });
  }
}

export async function setConcessionActive(ctx: AuthContext, input: ConcessionRefInput & { active: boolean }) {
  authorizeFeeWrite(ctx, "fee.concession.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const c = await lockConcession(tx, input.id, input.version);
      if (c.isActive === input.active) return;
      await tx.feeConcession.update({ where: { id: c.id }, data: { isActive: input.active, version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_concession.status_change", entityType: "FeeConcession", entityId: c.id, before: { isActive: c.isActive }, after: { isActive: input.active } });
    });
  } catch (e) {
    mapErrors(e, "concession");
  }
}

// ───────────────────────────── Effect estimate (KI-102) ─────────────────────────────

type ActiveStructure = { items: { id: string; categoryId: string; installmentId: string; amount: string; appliesTo: "ALL" | "NEW_ADMISSION" | "EXISTING" }[] } | null;

/** The session's active structures by class, loaded once per request (review L6). */
async function activeStructures(db: Tx | typeof prisma, academicSessionId: string) {
  const rows = await db.feeStructure.findMany({
    where: { academicSessionId, isActive: true },
    take: MAX_ROWS,
    select: { classId: true, items: { take: 400, select: { id: true, categoryId: true, installmentId: true, amount: true, category: { select: { appliesTo: true } } } } },
  });
  return new Map<string, ActiveStructure>(rows.map((r) => [r.classId, { items: r.items.map((i) => ({ id: i.id, categoryId: i.categoryId, installmentId: i.installmentId, amount: i.amount.toString(), appliesTo: i.category.appliesTo })) }]));
}

/**
 * Session effect of one concession for one student (KI-102; review L3): only the installments the student is billed
 * for (joiner / leaver rules) and the fee heads that apply to them (new admission or existing). Other concessions of
 * the student are not stacked in — the figure is this concession's own effect.
 */
function effectFor(st: ActiveStructure | undefined, installments: Map<string, string>, e: EnrollmentSummary, concession: ConcessionInput) {
  if (!st || st.items.length === 0) return null;
  const billed = new Set(billableInstallments(e, [...installments].map(([id, dueOn]) => ({ id, dueOn }))).map((i) => i.id));
  const byInst = new Map<string, { key: string; categoryId: string; amount: string }[]>();
  for (const i of st.items) {
    if (!billed.has(i.installmentId) || !itemApplies(i.appliesTo, e.newAdmission)) continue;
    byInst.set(i.installmentId, [...(byInst.get(i.installmentId) ?? []), { key: i.id, categoryId: i.categoryId, amount: i.amount }]);
  }
  if (byInst.size === 0) return null;
  const perInstallment = [...byInst.values()].map((lines) => sumMoney(priceLines(lines, [concession]).map((l) => l.concession)));
  return { installments: perInstallment.length, sessionTotal: moneyString(sumMoney(perInstallment)), largestInstallment: moneyString(perInstallment.reduce((x, y) => (y.gt(x) ? y : x), sumMoney([]))) };
}

// ───────────────────────────── Student concessions ─────────────────────────────

const iso = (d: Date) => d.toISOString().slice(0, 10);
function enrollmentOf(e: { status: string; enrolledOn: Date; leftOn: Date | null; student: { studentCode: string; fullName: string; admittedSessionId: string | null }; section: { code: string; classId: string } }, studentId: string, academicSessionId: string): EnrollmentSummary {
  return {
    studentId,
    academicSessionId,
    status: e.status as EnrollmentSummary["status"],
    enrolledOn: iso(e.enrolledOn),
    leftOn: e.leftOn ? iso(e.leftOn) : null,
    studentCode: e.student.studentCode,
    admissionNo: "",
    fullName: e.student.fullName,
    newAdmission: e.student.admittedSessionId === academicSessionId,
    classId: e.section.classId,
    className: "",
    sectionCode: e.section.code,
  };
}

/** Student lookup for the people who act on students (review Info: not every fee reader). */
export async function searchStudentsForFees(ctx: AuthContext, academicSessionId: string, q: string) {
  if (!canManage(ctx) && !holdsAll(ctx, "fee.structure.manage") && !holdsAll(ctx, "fee.collect")) throw new ForbiddenError();
  return searchEnrollments(prisma, academicSessionId, q);
}

export async function listStudentConcessions(ctx: AuthContext, academicSessionId: string, opts: { status?: "PROPOSED" | "APPROVED" | "REJECTED" | "REVOKED"; studentId?: string } = {}) {
  assertConcessionRead(ctx);
  const rows = await prisma.studentConcession.findMany({
    where: { academicSessionId, ...(opts.status ? { status: opts.status } : {}), ...(opts.studentId ? { studentId: opts.studentId } : {}) },
    orderBy: [{ status: "asc" }, { proposedAt: "desc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: {
      id: true,
      studentId: true,
      status: true,
      reason: true,
      version: true,
      proposedAt: true,
      decidedAt: true,
      proposedById: true,
      proposedBy: { select: { displayName: true } },
      decidedBy: { select: { displayName: true } },
      concession: { select: { id: true, name: true, calc: true, value: true, categories: { select: { categoryId: true } } } },
      enrollment: {
        select: { status: true, enrolledOn: true, leftOn: true, student: { select: { studentCode: true, fullName: true, admittedSessionId: true } }, section: { select: { code: true, classId: true } } },
      },
    },
  });
  const reasons = seesReasons(ctx);
  const [structures, installments] = await Promise.all([
    activeStructures(prisma, academicSessionId),
    prisma.feeInstallment.findMany({ where: { academicSessionId }, take: 200, select: { id: true, dueOn: true } }),
  ]);
  const instDue = new Map(installments.map((i) => [i.id, i.dueOn.toISOString().slice(0, 10)]));
  const out = [];
  for (const r of rows) {
    const c: ConcessionInput = { id: r.concession.id, calc: r.concession.calc, value: r.concession.value.toString(), categoryIds: r.concession.categories.map((x) => x.categoryId) };
    out.push({
      id: r.id,
      version: r.version,
      status: r.status,
      studentId: r.studentId,
      studentCode: r.enrollment.student.studentCode,
      fullName: r.enrollment.student.fullName,
      sectionCode: r.enrollment.section.code,
      concessionName: r.concession.name,
      calc: r.concession.calc,
      value: moneyString(r.concession.value.toString()),
      reason: reasons ? r.reason : null,
      proposedBy: r.proposedBy?.displayName ?? null,
      proposedAt: r.proposedAt,
      decidedBy: r.decidedBy?.displayName ?? null,
      decidedAt: r.decidedAt,
      ownProposal: r.proposedById === ctx.userId,
      effect:
        r.status === "PROPOSED" || r.status === "APPROVED"
          ? effectFor(structures.get(r.enrollment.section.classId), instDue, enrollmentOf(r.enrollment, r.studentId, academicSessionId), c)
          : null,
    });
  }
  return out;
}

export async function proposeConcession(ctx: AuthContext, input: ProposeConcessionInput) {
  authorizeFeeWrite(ctx, "fee.concession.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      await writableSession(tx, input.academicSessionId);
      const e = await enrollmentSummary(tx, input.studentId, input.academicSessionId);
      if (!e) throw new NotFoundError("This student isn't enrolled in the session.");
      if (e.status === "PROMOTED" || e.status === "DETAINED") throw new ConflictError("This enrollment is closed (promoted or detained); concessions apply to the student's current session.");
      const c = await tx.feeConcession.findUnique({ where: { id: input.concessionId }, select: { isActive: true } });
      if (!c?.isActive) throw new NotFoundError("Concession not found or inactive.");
      const row = await tx.studentConcession.create({ data: { studentId: input.studentId, academicSessionId: input.academicSessionId, concessionId: input.concessionId, reason: input.reason, proposedById: ctx.userId }, select: { id: true } });
      await audit(tx, actorOf(ctx), { action: "student_concession.propose", entityType: "StudentConcession", entityId: row.id, after: { studentId: input.studentId, academicSessionId: input.academicSessionId, concessionId: input.concessionId } });
      return row;
    });
  } catch (e) {
    mapErrors(e, "concession");
  }
}

async function lockStudentConcession(tx: Tx, id: string, version: number) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student_concession WHERE id = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Concession not found.");
  const r = await tx.studentConcession.findUniqueOrThrow({ where: { id }, select: { id: true, status: true, version: true, proposedById: true, academicSessionId: true, concession: { select: { isActive: true } } } });
  if (r.version !== version) throw stale("concession");
  return r;
}

/** Approve or reject a proposal — never by its proposer (Super Admin included). */
export async function decideConcession(ctx: AuthContext, input: DecideConcessionInput) {
  authorizeFeeWrite(ctx, "fee.concession.approve");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const r = await lockStudentConcession(tx, input.id, input.version);
      if (r.status !== "PROPOSED") throw new ConflictError("This concession has already been decided.");
      await writableSession(tx, r.academicSessionId);
      if (r.proposedById === ctx.userId) throw new ForbiddenError("You proposed this concession, so someone else must decide it.");
      if (r.proposedById === null && !ctx.isSuperAdmin) throw new ForbiddenError("The person who proposed this is no longer a user; only a Super Admin can decide it.");
      if (input.decision === "APPROVE" && !r.concession.isActive) throw new ConflictError("This concession template was deactivated, so it can only be rejected.");
      const status = input.decision === "APPROVE" ? "APPROVED" : "REJECTED";
      await tx.studentConcession.update({ where: { id: r.id }, data: { status, decidedById: ctx.userId, decidedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: input.decision === "APPROVE" ? "student_concession.approve" : "student_concession.reject", entityType: "StudentConcession", entityId: r.id, before: { status: r.status }, after: { status } });
    });
  } catch (e) {
    mapErrors(e, "concession");
  }
}

/** Withdraw an approved concession for future invoices (issued invoices keep theirs). */
export async function revokeConcession(ctx: AuthContext, input: ConcessionRefInput) {
  authorizeFeeWrite(ctx, "fee.concession.approve");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const r = await lockStudentConcession(tx, input.id, input.version);
      if (r.status !== "APPROVED") throw new ConflictError("Only an approved concession can be revoked.");
      await writableSession(tx, r.academicSessionId);
      await tx.studentConcession.update({ where: { id: r.id }, data: { status: "REVOKED", version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "student_concession.revoke", entityType: "StudentConcession", entityId: r.id, before: { status: r.status }, after: { status: "REVOKED" } });
    });
  } catch (e) {
    mapErrors(e, "concession");
  }
}

// ───────────────────────────── Charges (FC18) ─────────────────────────────

export async function listCharges(ctx: AuthContext, academicSessionId: string) {
  if (!canReadFees(ctx) && !holdsAll(ctx, "fee.structure.manage")) throw new ForbiddenError();
  const rows = await prisma.studentFeeCharge.findMany({
    where: { academicSessionId, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: MAX_ROWS,
    select: {
      id: true,
      version: true,
      amount: true,
      note: true,
      source: true,
      studentId: true,
      installment: { select: { name: true } },
      category: { select: { name: true } },
      invoiceItem: { select: { id: true } },
      enrollment: { select: { student: { select: { studentCode: true, fullName: true } }, section: { select: { code: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    amount: moneyString(r.amount.toString()),
    note: r.note,
    source: r.source,
    studentCode: r.enrollment.student.studentCode,
    fullName: r.enrollment.student.fullName,
    sectionCode: r.enrollment.section.code,
    installmentName: r.installment.name,
    categoryName: r.category.name,
    invoiced: r.invoiceItem !== null,
  }));
}

export async function addCharge(ctx: AuthContext, input: AddChargeInput) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      await writableSession(tx, input.academicSessionId);
      const e = await enrollmentSummary(tx, input.studentId, input.academicSessionId);
      if (!e) throw new NotFoundError("This student isn't enrolled in the session.");
      const [cat, inst] = await Promise.all([
        tx.feeCategory.findUnique({ where: { id: input.categoryId }, select: { isActive: true, kind: true } }),
        tx.feeInstallment.findFirst({ where: { id: input.installmentId, academicSessionId: input.academicSessionId }, select: { id: true, dueOn: true } }),
      ]);
      if (!cat?.isActive || SYSTEM_KINDS.has(cat.kind)) throw new ValidationError("Choose an active fee head.", [{ path: "categoryId", message: "Unknown or system fee head." }]);
      if (!inst) throw new ValidationError("Choose one of this session's installments.", [{ path: "installmentId", message: "Unknown installment." }]);
      // Review L5: same enrollment rules as billing — otherwise the charge would never reach an invoice.
      if (e.status === "PROMOTED" || e.status === "DETAINED") throw new ConflictError("This enrollment is closed (promoted or detained).");
      if (billableInstallments(e, [{ id: inst.id, dueOn: iso(inst.dueOn) }]).length === 0) throw new ConflictError("The student isn't billed for this installment (joined after it, or left before it).");
      const row = await tx.studentFeeCharge.create({
        data: { studentId: input.studentId, academicSessionId: input.academicSessionId, installmentId: input.installmentId, categoryId: input.categoryId, amount: input.amount, note: input.note, createdById: ctx.userId },
        select: { id: true },
      });
      // Review L4: the amount is recorded (a financial change must be reconstructable); the note is free text and stays out.
      await audit(tx, actorOf(ctx), { action: "fee_charge.add", entityType: "StudentFeeCharge", entityId: row.id, after: { studentId: input.studentId, installmentId: input.installmentId, categoryId: input.categoryId, amount: moneyString(input.amount) } });
      return row;
    });
  } catch (e) {
    mapErrors(e, "charge");
  }
}

export async function removeCharge(ctx: AuthContext, input: ConcessionRefInput) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM student_fee_charge WHERE id = ${input.id} AND deleted_at IS NULL FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Charge not found.");
      const c = await tx.studentFeeCharge.findUniqueOrThrow({ where: { id: input.id }, select: { version: true, source: true, academicSessionId: true, studentId: true, installmentId: true, categoryId: true, amount: true, invoiceItem: { select: { id: true } } } });
      if (c.version !== input.version) throw stale("charge");
      if (c.source !== "MANUAL") throw new ConflictError("Transport charges are managed by transport.");
      if (c.invoiceItem) throw new ConflictError("This charge is already on an invoice.");
      await writableSession(tx, c.academicSessionId);
      await tx.studentFeeCharge.update({ where: { id: input.id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
      await audit(tx, actorOf(ctx), { action: "fee_charge.remove", entityType: "StudentFeeCharge", entityId: input.id, before: { studentId: c.studentId, installmentId: c.installmentId, categoryId: c.categoryId, amount: moneyString(c.amount.toString()) } });
    });
  } catch (e) {
    mapErrors(e, "charge");
  }
}
