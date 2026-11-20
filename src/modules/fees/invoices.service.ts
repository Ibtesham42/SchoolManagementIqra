import { randomUUID } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { AppError } from "@/lib/errors";
import { ConflictError, NotFoundError, ServiceBusyError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { moneyString, sumMoney } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { formatSequence, nextSequenceBlock, sequenceKey } from "@/lib/sequence";
import { lockSessionShared, sessionFacts } from "@/modules/academic/academic.tx";
import { readFeeSettingsTx } from "@/modules/settings/settings.service";
import { classEnrollments, enrollmentSummary, type EnrollmentSummary } from "@/modules/students/enrollment-reads.tx";
import type { ConcessionInput } from "./fee-calc";
import { billableInstallments, sessionGeneratesInvoices } from "./fee-rules";
import { assertFeeRead, assertFeeSetupRead, authorizeFeeWrite } from "./fees.policy";
import { lockFeeSetup } from "./fees.tx";
import { buildInvoice, repriceItems, type BuiltInvoice, type ChargeLine, type StructureLine } from "./invoice-build";
import type { CancelInvoiceInput, GenerateInvoicesInput } from "./invoices.schemas";

/**
 * Phase 5A-M4 — invoice generation, cancellation, re-pricing and the student fee ledger (PHASE_5_PLAN.md FC4–FC6,
 * FC12, FC18, FC25; ADR-040; KI-103).
 *
 * - Generate (`fee.structure.manage` at ALL): for ONE class and ONE installment of a PLANNED / ACTIVE session, from the
 *   class's ACTIVE structure. Preview first (no writes), then issue in one transaction under the fee-setup lock:
 *   billable enrollments only (FC4), students already invoiced for the installment are skipped (partial unique — a
 *   re-run is idempotent), approved concessions apply, unbilled charges are attached, numbers come from one sequence
 *   block (gap-free; formats required, FC12) and every invoice records its structure (KI-103).
 * - Cancel (`fee.structure.manage`): only an invoice with nothing paid; reason kept on the row (never audited); the
 *   invoice's extra charges are re-created unbilled so a re-issue bills them again.
 * - Re-price (FC6): `repriceUnpaidInvoicesTx` is called by the concession service when a concession is approved or
 *   revoked — every live, fully UNPAID installment invoice of the student in the session gets the new concessions.
 * - Ledger: `fee.read` ALL — the student's invoices across sessions with items, paid and balance.
 * Audit rows carry ids, counts and batch totals — never per-student amounts or reasons.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const MAX_INVOICES_PER_RUN = 1000;

function mapErrors(e: unknown): never {
  if (e instanceof AppError) throw e;
  // Review 5A-M4 L4: name the collision — a number clash after a format change isn't "issued meanwhile".
  if (isUniqueViolation(e, "invoiceNo")) throw new ConflictError("An invoice number made with the current format already exists. Change the invoice number format (for example add {SESSION}) and try again.");
  if (isUniqueViolation(e)) throw new ConflictError("Invoices were issued meanwhile. Reload the page and try again.");
  if (isTransactionBusy(e)) throw new ServiceBusyError();
  if (e instanceof RangeError || (e instanceof Error && /^Missing value for \{/.test(e.message))) {
    throw new ConflictError("These invoices can't be numbered or totalled with the current settings (check the school short code, the number format and the amounts).");
  }
  throw e;
}

type Db = Tx | typeof prisma;

/** What one class / installment run would bill (shared by preview and issue). */
async function planRun(db: Db, input: GenerateInvoicesInput) {
  const s = await sessionFacts(db as Tx, input.academicSessionId);
  if (!sessionGeneratesInvoices(s.status)) throw new ConflictError("This academic session is closed; invoices can't be generated.");
  const inst = await db.feeInstallment.findFirst({ where: { id: input.installmentId, academicSessionId: s.id }, select: { id: true, name: true, dueOn: true } });
  if (!inst) throw new NotFoundError("Installment not found.");
  const structure = await db.feeStructure.findFirst({
    where: { academicSessionId: s.id, classId: input.classId, isActive: true },
    // Review L2: a fixed line order, so a FIXED concession always lands on the same lines (preview = issue = re-price).
    select: { id: true, name: true, items: { where: { installmentId: inst.id }, orderBy: [{ category: { name: "asc" } }, { id: "asc" }], select: { id: true, categoryId: true, amount: true, category: { select: { name: true, appliesTo: true } } } } },
  });
  if (!structure) throw new ConflictError("This class has no active fee structure in the session.");
  const roster = await classEnrollments(db, s.id, input.classId, MAX_INVOICES_PER_RUN + 1);
  if (roster.length > MAX_INVOICES_PER_RUN) throw new ConflictError(`At most ${MAX_INVOICES_PER_RUN} students per run.`);
  const instDue = iso(inst.dueOn);
  const billable = roster.filter((e) => billableInstallments(e, [{ id: inst.id, dueOn: instDue }]).length > 0);
  const ids = billable.map((e) => e.studentId);
  const [existing, concessions, charges] = await Promise.all([
    db.feeInvoice.findMany({ where: { academicSessionId: s.id, installmentId: inst.id, deletedAt: null, studentId: { in: ids } }, select: { studentId: true } }),
    db.studentConcession.findMany({
      where: { academicSessionId: s.id, status: "APPROVED", studentId: { in: ids } },
      select: { studentId: true, concession: { select: { id: true, calc: true, value: true, categories: { select: { categoryId: true } } } } },
    }),
    db.studentFeeCharge.findMany({
      where: { academicSessionId: s.id, installmentId: inst.id, deletedAt: null, invoiceItem: null, studentId: { in: ids } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, studentId: true, categoryId: true, amount: true, category: { select: { name: true } } },
    }),
  ]);
  const invoiced = new Set(existing.map((x) => x.studentId));
  const concByStudent = new Map<string, ConcessionInput[]>();
  for (const c of concessions) {
    concByStudent.set(c.studentId, [...(concByStudent.get(c.studentId) ?? []), { id: c.concession.id, calc: c.concession.calc, value: c.concession.value.toString(), categoryIds: c.concession.categories.map((x) => x.categoryId) }]);
  }
  const chargesByStudent = new Map<string, ChargeLine[]>();
  for (const c of charges) chargesByStudent.set(c.studentId, [...(chargesByStudent.get(c.studentId) ?? []), { chargeId: c.id, categoryId: c.categoryId, categoryName: c.category.name, amount: c.amount.toString() }]);
  const lines: StructureLine[] = structure.items.map((i) => ({ structureItemId: i.id, categoryId: i.categoryId, categoryName: i.category.name, appliesTo: i.category.appliesTo, amount: i.amount.toString() }));
  const toIssue: { e: EnrollmentSummary; built: BuiltInvoice }[] = [];
  let nothingToBill = 0;
  for (const e of billable) {
    if (invoiced.has(e.studentId)) continue;
    const built = buildInvoice(lines, chargesByStudent.get(e.studentId) ?? [], concByStudent.get(e.studentId) ?? [], e.newAdmission);
    if (built) toIssue.push({ e, built });
    else nothingToBill += 1;
  }
  return {
    session: s,
    installment: { id: inst.id, name: inst.name, dueOn: instDue },
    structure: { id: structure.id, name: structure.name },
    toIssue,
    counts: { roster: roster.length, notBillable: roster.length - billable.length, alreadyInvoiced: invoiced.size, nothingToBill, toIssue: toIssue.length },
    total: moneyString(sumMoney(toIssue.map((t) => t.built.total))),
  };
}

/** Preview (no writes): who would be invoiced and for how much. */
export async function previewInvoices(ctx: AuthContext, input: GenerateInvoicesInput) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  const p = await planRun(prisma, input);
  return {
    installment: p.installment,
    structure: p.structure,
    counts: p.counts,
    /** Review L3: posted back with the issue so the run issued is the run reviewed. */
    total: p.total,
    rows: p.toIssue.slice(0, 200).map((t) => ({ studentId: t.e.studentId, studentCode: t.e.studentCode, fullName: t.e.fullName, sectionCode: t.e.sectionCode, total: t.built.total, concession: t.built.concessionTotal, status: t.built.status })),
  };
}

/** Issue the run in ONE transaction (sequence block; idempotent re-runs). */
export async function issueInvoices(ctx: AuthContext, input: GenerateInvoicesInput, expected?: { count: number; total: string; structureId: string }) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockFeeSetup(tx);
        const status = await lockSessionShared(tx, input.academicSessionId);
        if (!sessionGeneratesInvoices(status)) throw new ConflictError("This academic session is closed; invoices can't be generated.");
        // Review L4: the settings row FOR SHARE, so the number format can't change while this batch is being numbered.
        await tx.$queryRaw`SELECT id FROM school_setting WHERE id = 'default' FOR SHARE`;
        const settings = await readFeeSettingsTx(tx);
        if (!settings.feeInvoice) throw new ConflictError("Set the invoice number format first (Fees → Fee heads).");
        const p = await planRun(tx, input);
        // Review L3: issue exactly what the user reviewed.
        if (expected && (expected.count !== p.toIssue.length || expected.total !== p.total || expected.structureId !== p.structure.id)) {
          throw new ConflictError("The figures changed since the preview (a concession, charge or fee structure changed). Review the preview again.");
        }
        if (p.toIssue.length === 0) return { issued: 0, counts: p.counts, total: "0.00" };
        const today = todayInTimeZone(settings.timezone ?? undefined);
        const tokens = { code: settings.shortCode ?? undefined, year: Number(today.slice(0, 4)), session: p.session.name };
        const key = sequenceKey("fee_invoice", settings.feeInvoice, tokens);
        const first = await nextSequenceBlock(tx, key, p.toIssue.length);
        const rows = p.toIssue.map((t, i) => {
          const invoiceNo = formatSequence(settings.feeInvoice!, first + i, tokens);
          // Review 5A-M2 L2: the rendered number must still fit (profile or session names may have changed).
          if (invoiceNo.length > 40) throw new ConflictError("Invoice numbers made with the current format are longer than 40 characters. Shorten the format.");
          return { id: randomUUID(), invoiceNo, t };
        });
        await tx.feeInvoice.createMany({
          data: rows.map(({ id, invoiceNo, t }) => ({
            id,
            invoiceNo,
            studentId: t.e.studentId,
            academicSessionId: p.session.id,
            kind: "INSTALLMENT" as const,
            installmentId: p.installment.id,
            structureId: p.structure.id,
            dueOn: day(p.installment.dueOn),
            subtotal: t.built.subtotal,
            concessionTotal: t.built.concessionTotal,
            total: t.built.total,
            status: t.built.status,
            issuedById: ctx.userId,
          })),
        });
        await tx.feeInvoiceItem.createMany({
          data: rows.flatMap(({ id, t }) =>
            t.built.items.map((it) => ({ invoiceId: id, categoryId: it.categoryId, kind: it.kind, description: it.description, amount: it.amount, concessionAmount: it.concessionAmount, sortOrder: it.sortOrder, chargeId: it.chargeId })),
          ),
        });
        await audit(tx, actorOf(ctx), {
          action: "fee_invoice.issue_batch",
          entityType: "FeeInstallment",
          entityId: p.installment.id,
          after: { classId: input.classId, structureId: p.structure.id, issued: rows.length, first: rows[0].invoiceNo, last: rows[rows.length - 1].invoiceNo, total: p.total, ...p.counts },
        });
        return { issued: rows.length, counts: p.counts, total: p.total };
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    mapErrors(e);
  }
}

/** Cancel an UNPAID invoice (FC5). Its extra charges are re-created unbilled for a re-issue. */
export async function cancelInvoice(ctx: AuthContext, input: CancelInvoiceInput) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  try {
    await prisma.$transaction(async (tx) => {
      await lockFeeSetup(tx);
      const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM fee_invoice WHERE id = ${input.id} AND deleted_at IS NULL FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Invoice not found.");
      const inv = await tx.feeInvoice.findUniqueOrThrow({
        where: { id: input.id },
        select: { version: true, paidAmount: true, status: true, academicSessionId: true, installmentId: true, _count: { select: { allocations: true } }, items: { where: { kind: "CHARGE" }, select: { charge: true } } },
      });
      if (inv.version !== input.version) throw new ConflictError("This invoice was changed by someone else. Reload the page and try again.");
      // Review 5A-M4 M1: only while the session still generates invoices, so a cancelled invoice can always be re-issued
      // (a cancel in a closed session would be an unapproved 100 % waiver).
      const sessionStatus = await lockSessionShared(tx, inv.academicSessionId);
      if (!sessionGeneratesInvoices(sessionStatus)) throw new ConflictError("This academic session is closed, so its invoices can't be cancelled (they could never be issued again). Use a concession instead.");
      if (inv._count.allocations > 0 || !inv.paidAmount.isZero()) throw new ConflictError("Payments were received on this invoice, so it can't be cancelled. Use a concession or waiver instead.");
      await tx.feeInvoice.update({ where: { id: input.id }, data: { status: "CANCELLED", deletedAt: new Date(), cancelledAt: new Date(), cancelledById: ctx.userId, cancelReason: input.reason, version: { increment: 1 } } });
      // Review L5: re-create the extra charges only while the student is still billed for the installment; ids audited.
      const recreated: string[] = [];
      const dropped: string[] = [];
      for (const { charge } of inv.items) {
        if (!charge || charge.deletedAt) continue;
        await tx.studentFeeCharge.update({ where: { id: charge.id }, data: { deletedAt: new Date(), version: { increment: 1 } } });
        const e = await enrollmentSummary(tx, charge.studentId, charge.academicSessionId);
        const inst = await tx.feeInstallment.findUnique({ where: { id: charge.installmentId }, select: { id: true, dueOn: true } });
        if (!e || !inst || billableInstallments(e, [{ id: inst.id, dueOn: iso(inst.dueOn) }]).length === 0) {
          dropped.push(charge.id);
          continue;
        }
        const n = await tx.studentFeeCharge.create({
          data: { studentId: charge.studentId, academicSessionId: charge.academicSessionId, installmentId: charge.installmentId, categoryId: charge.categoryId, amount: charge.amount, source: charge.source, sourceRef: charge.sourceRef, note: charge.note, createdById: charge.createdById },
          select: { id: true },
        });
        recreated.push(n.id);
      }
      await audit(tx, actorOf(ctx), { action: "fee_invoice.cancel", entityType: "FeeInvoice", entityId: input.id, before: { status: inv.status }, after: { status: "CANCELLED", chargesRecreated: recreated, chargesDropped: dropped } });
    });
  } catch (e) {
    mapErrors(e);
  }
}

/**
 * FC6: re-price the student's live, fully UNPAID installment invoices of the session with the currently APPROVED
 * concessions. Called INSIDE the concession service's transaction (it holds the fee-setup lock). Returns the count.
 */
export async function repriceUnpaidInvoicesTx(tx: Tx, studentId: string, academicSessionId: string): Promise<number> {
  // Review L1: lock WITH the full "unpaid" predicate, then read only the locked rows (a payment can't slip in between).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM fee_invoice
    WHERE student_id = ${studentId} AND academic_session_id = ${academicSessionId} AND kind = 'INSTALLMENT'
      AND deleted_at IS NULL AND paid_amount = 0 AND status IN ('ISSUED', 'WAIVED')
    ORDER BY id LIMIT 100 FOR UPDATE`;
  if (locked.length === 0) return 0;
  const invoices = await tx.feeInvoice.findMany({
    where: { id: { in: locked.map((l) => l.id) }, paidAmount: 0 },
    select: { id: true, items: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, kind: true, categoryId: true, amount: true, concessionAmount: true } } },
  });
  const approved = await tx.studentConcession.findMany({
    where: { studentId, academicSessionId, status: "APPROVED" },
    select: { concession: { select: { id: true, calc: true, value: true, categories: { select: { categoryId: true } } } } },
  });
  const concessions: ConcessionInput[] = approved.map((a) => ({ id: a.concession.id, calc: a.concession.calc, value: a.concession.value.toString(), categoryIds: a.concession.categories.map((c) => c.categoryId) }));
  let changed = 0;
  for (const inv of invoices) {
    const r = repriceItems(inv.items.map((i) => ({ id: i.id, kind: i.kind, categoryId: i.categoryId, amount: i.amount.toString(), concessionAmount: i.concessionAmount.toString() })), concessions);
    const before = new Map(inv.items.map((i) => [i.id, moneyString(i.concessionAmount.toString())]));
    if (r.items.every((n) => before.get(n.id) === n.concessionAmount)) continue;
    for (const n of r.items) if (before.get(n.id) !== n.concessionAmount) await tx.feeInvoiceItem.update({ where: { id: n.id }, data: { concessionAmount: n.concessionAmount } });
    await tx.feeInvoice.update({ where: { id: inv.id }, data: { concessionTotal: r.concessionTotal, total: r.total, status: r.status, version: { increment: 1 } } });
    changed += 1;
  }
  return changed;
}

// ───────────────────────────── Reads ─────────────────────────────

/** Invoices of a class and installment (setup readers). */
export async function listInvoices(ctx: AuthContext, input: { academicSessionId: string; installmentId: string; classId?: string }) {
  assertFeeSetupRead(ctx);
  const rows = await prisma.feeInvoice.findMany({
    where: { academicSessionId: input.academicSessionId, installmentId: input.installmentId, ...(input.classId ? { enrollment: { section: { classId: input.classId } } } : {}) },
    orderBy: [{ invoiceNo: "asc" }],
    take: 500,
    select: {
      id: true,
      invoiceNo: true,
      status: true,
      total: true,
      paidAmount: true,
      version: true,
      studentId: true,
      deletedAt: true,
      enrollment: { select: { student: { select: { studentCode: true, fullName: true } }, section: { select: { code: true } } } },
    },
  });
  const live = new Set(rows.filter((r) => r.deletedAt === null).map((r) => r.studentId));
  return rows.map((r) => ({
    notReissued: r.deletedAt !== null && !live.has(r.studentId),
    id: r.id,
    invoiceNo: r.invoiceNo,
    status: r.status,
    total: moneyString(r.total.toString()),
    paid: moneyString(r.paidAmount.toString()),
    balance: moneyString(r.total.minus(r.paidAmount).toString()),
    version: r.version,
    studentId: r.studentId,
    studentCode: r.enrollment.student.studentCode,
    fullName: r.enrollment.student.fullName,
    sectionCode: r.enrollment.section.code,
    cancelled: r.deletedAt !== null,
  }));
}

/** One student's fee ledger across sessions (`fee.read` ALL). Unknown or removed student → NotFound. */
export async function getStudentFeeLedger(ctx: AuthContext, studentId: string) {
  assertFeeRead(ctx);
  const invoices = await prisma.feeInvoice.findMany({
    where: { studentId },
    orderBy: [{ dueOn: "asc" }, { invoiceNo: "asc" }],
    take: 300,
    select: {
      id: true,
      invoiceNo: true,
      kind: true,
      status: true,
      dueOn: true,
      subtotal: true,
      concessionTotal: true,
      lateFee: true,
      total: true,
      paidAmount: true,
      version: true,
      deletedAt: true,
      academicSessionId: true,
      enrollment: { select: { academicSession: { select: { name: true } } } },
      installment: { select: { name: true } },
      items: { orderBy: { sortOrder: "asc" }, select: { id: true, kind: true, description: true, amount: true, concessionAmount: true, paidAmount: true } },
    },
  });
  // The latest session the student was invoiced in names the class shown (soft-deleted students → NotFound).
  const latest = invoices[invoices.length - 1];
  const who = latest ? await enrollmentSummary(prisma, studentId, latest.academicSessionId) : null;
  if (latest && !who) throw new NotFoundError("Student not found.");
  const live = invoices.filter((i) => i.deletedAt === null);
  const balance = sumMoney(live.map((i) => i.total.minus(i.paidAmount).toString()));
  return {
    student: who ? { studentId, studentCode: who.studentCode, fullName: who.fullName, className: who.className, sectionCode: who.sectionCode } : null,
    balance: moneyString(balance),
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      kind: i.kind,
      status: i.status,
      dueOn: iso(i.dueOn),
      sessionName: i.enrollment.academicSession.name,
      installmentName: i.installment?.name ?? "Previous dues",
      subtotal: moneyString(i.subtotal.toString()),
      concession: moneyString(i.concessionTotal.toString()),
      lateFee: moneyString(i.lateFee.toString()),
      total: moneyString(i.total.toString()),
      paid: moneyString(i.paidAmount.toString()),
      balance: moneyString(i.total.minus(i.paidAmount).toString()),
      version: i.version,
      cancelled: i.deletedAt !== null,
      items: i.items.map((it) => ({ id: it.id, kind: it.kind, description: it.description, amount: moneyString(it.amount.toString()), concession: moneyString(it.concessionAmount.toString()), paid: moneyString(it.paidAmount.toString()) })),
    })),
  };
}

