import { randomUUID } from "node:crypto";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { isTransactionBusy, isUniqueViolation } from "@/lib/db-errors";
import { AppError, ConflictError, ServiceBusyError, ValidationError } from "@/lib/errors";
import { todayInTimeZone } from "@/lib/format";
import { readTable, toXlsx } from "@/lib/import/tabular";
import { moneyString, sumMoney, toMoney } from "@/lib/money";
import type { AuthContext } from "@/lib/rbac/authorize";
import { formatSequence, nextSequenceBlock, sequenceKey } from "@/lib/sequence";
import { lockSessionShared, sessionFacts } from "@/modules/academic/academic.tx";
import { readFeeSettingsTx } from "@/modules/settings/settings.service";
import { classEnrollments } from "@/modules/students/enrollment-reads.tx";
import { sessionGeneratesInvoices } from "./fee-rules";
import { authorizeFeeWrite } from "./fees.policy";
import { lockFeeSetup } from "./fees.tx";
import { OPENING_MAX, OPENING_TEMPLATE_HEADER, openingDueProblem, planOpeningImport, type OpeningRosterRow } from "./opening-import.rules";
import type { OpeningImportInput, OpeningRefInput } from "./opening.schemas";

/**
 * Phase 5C-M3 — opening balances (PHASE_5_PLAN.md FC19): previous dues from the old system, per student, as one
 * OPENING_BALANCE invoice per (student, session) — a partial unique index makes a re-run idempotent.
 * - `fee.structure.manage` at ALL (marks-import precedent: the domain permission, not `import.run`).
 * - Template per class (an upload holds at most 500 rows), CSV or XLSX, formula-safe, audited.
 * - Upload → preview: parsed in memory (lib/import/tabular: size, zip-bomb, row / column caps), never stored, writes
 *   nothing. Confirm re-submits the planned entries; the service re-checks every one under the fee-setup lock (session
 *   still generates invoices, student enrolled in the class, no live previous dues yet, amount ≤ OPENING_MAX, the total
 *   is the one previewed) and numbers the invoices from one sequence block (gap-free).
 * - No past payments are imported (FC19). Late-fee rules of the session apply after the chosen due date.
 * Audit: counts, first / last invoice number, the due date and the batch total (only from 3 students — review L3) —
 * never per-student amounts.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const OPENING_MAX_ROWS = 500;
type Db = Tx | typeof prisma;

async function rosterOf(db: Db, ref: OpeningRefInput): Promise<(OpeningRosterRow & { className: string; sectionCode: string })[]> {
  const roster = await classEnrollments(db, ref.academicSessionId, ref.classId, OPENING_MAX_ROWS + 1);
  if (roster.length > OPENING_MAX_ROWS) throw new ConflictError(`This class has more than ${OPENING_MAX_ROWS} students; ask for the import to be split by section.`);
  const existing = await db.feeInvoice.findMany({
    where: { academicSessionId: ref.academicSessionId, kind: "OPENING_BALANCE", deletedAt: null, studentId: { in: roster.map((r) => r.studentId) } },
    select: { studentId: true, total: true },
  });
  const have = new Map(existing.map((e) => [e.studentId, moneyString(e.total.toString())]));
  return roster.map((r) => ({ studentId: r.studentId, studentCode: r.studentCode, fullName: r.fullName, existing: have.get(r.studentId) ?? null, className: r.className, sectionCode: r.sectionCode }));
}

/** Template for one class: its students and any previous dues already imported. */
export async function openingTemplate(ctx: AuthContext, ref: OpeningRefInput, format: "csv" | "xlsx") {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  const s = await sessionFacts(prisma as unknown as Tx, ref.academicSessionId);
  const roster = await rosterOf(prisma, ref);
  const rows = roster.map((r) => [r.studentCode, r.fullName, r.className, r.sectionCode, r.existing]);
  const body = format === "csv" ? new TextEncoder().encode(toCsv(OPENING_TEMPLATE_HEADER, rows)) : await toXlsx("Previous dues", OPENING_TEMPLATE_HEADER, rows);
  await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "fee_opening.template", entityType: "AcademicSession", entityId: ref.academicSessionId, after: { classId: ref.classId, rows: rows.length, format } }));
  const stem = `previous-dues-${s.name}-${roster[0]?.className ?? "class"}`.replace(/[^A-Za-z0-9-]+/g, "-").replace(/-+/g, "-").slice(0, 80);
  return { body, fileName: `${stem}.${format}`, contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
}

/** Upload → preview. Writes nothing. */
export async function previewOpeningImport(ctx: AuthContext, ref: OpeningRefInput, file: { bytes: Uint8Array; fileName: string }) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  const s = await sessionFacts(prisma as unknown as Tx, ref.academicSessionId);
  if (!sessionGeneratesInvoices(s.status)) throw new ConflictError("This academic session is closed; previous dues can't be added to it.");
  const roster = await rosterOf(prisma, ref);
  const { format, rows } = await readTable(file.bytes, file.fileName);
  const plan = planOpeningImport(rows, roster);
  return { format, plan, canConfirm: plan.fileProblem === null && plan.counts.problems === 0 && plan.entries.length > 0 };
}

/** The OPENING_BALANCE system head, created on first use (its code is reserved in setup). */
async function openingCategory(tx: Tx) {
  return tx.feeCategory.upsert({ where: { code: "OPENING_BALANCE" }, update: {}, create: { code: "OPENING_BALANCE", name: "Previous dues", nameKey: "previous dues (system)", kind: "OPENING_BALANCE", appliesTo: "ALL" }, select: { id: true, name: true } });
}

/** Confirm: create the previewed previous-dues invoices in ONE transaction (idempotent: existing ones are skipped). */
export async function importOpeningBalances(ctx: AuthContext, input: OpeningImportInput) {
  authorizeFeeWrite(ctx, "fee.structure.manage");
  const max = toMoney(OPENING_MAX);
  if (input.entries.some((e) => toMoney(e.amount).gt(max))) throw new ValidationError("An amount is above the limit. Upload the file again.");
  if (moneyString(sumMoney(input.entries.map((e) => e.amount))) !== moneyString(input.expectedTotal)) throw new ValidationError("The import doesn't match the preview. Upload the file again.");
  try {
    return await prisma.$transaction(
      async (tx) => {
        await lockFeeSetup(tx);
        const status = await lockSessionShared(tx, input.academicSessionId);
        if (!sessionGeneratesInvoices(status)) throw new ConflictError("This academic session is closed; previous dues can't be added to it.");
        await tx.$queryRaw`SELECT id FROM school_setting WHERE id = 'default' FOR SHARE`;
        const settings = await readFeeSettingsTx(tx);
        if (!settings.feeInvoice) throw new ConflictError("Set the invoice number format first (Fees → Fee heads).");
        const roster = new Map((await rosterOf(tx, input)).map((r) => [r.studentId, r]));
        for (const e of input.entries) if (!roster.has(e.studentId)) throw new ConflictError("A student in the import is no longer in this class. Upload the file again.");
        const toCreate = input.entries.filter((e) => roster.get(e.studentId)!.existing === null);
        const skipped = input.entries.length - toCreate.length;
        if (toCreate.length === 0) return { created: 0, skipped, total: "0.00" };
        const today = todayInTimeZone(settings.timezone ?? undefined);
        const s = await sessionFacts(tx, input.academicSessionId);
        // Review 5C-M3 L1: the due date inside the session and not long past.
        const dueProblem = openingDueProblem(input.dueOn, today, { startDate: s.startDate.toISOString().slice(0, 10), endDate: s.endDate.toISOString().slice(0, 10) });
        if (dueProblem) throw new ValidationError(dueProblem, [{ path: "dueOn", message: dueProblem }]);
        const tokens = { code: settings.shortCode ?? undefined, year: Number(today.slice(0, 4)), session: s.name };
        const first = await nextSequenceBlock(tx, sequenceKey("fee_invoice", settings.feeInvoice, tokens), toCreate.length);
        const cat = await openingCategory(tx);
        const rows = toCreate.map((e, i) => {
          const invoiceNo = formatSequence(settings.feeInvoice!, first + i, tokens);
          if (invoiceNo.length > 40) throw new ConflictError("Invoice numbers made with the current format are longer than 40 characters. Shorten the format.");
          return { id: randomUUID(), invoiceNo, e };
        });
        await tx.feeInvoice.createMany({
          data: rows.map(({ id, invoiceNo, e }) => ({ id, invoiceNo, studentId: e.studentId, academicSessionId: input.academicSessionId, kind: "OPENING_BALANCE" as const, dueOn: day(input.dueOn), subtotal: e.amount, total: e.amount, status: "ISSUED" as const, issuedById: ctx.userId })),
        });
        await tx.feeInvoiceItem.createMany({ data: rows.map(({ id, e }) => ({ invoiceId: id, categoryId: cat.id, kind: "OPENING_BALANCE" as const, description: cat.name, amount: e.amount, sortOrder: 0 })) });
        const total = moneyString(sumMoney(toCreate.map((e) => e.amount)));
        // Review L3: a batch total of one or two students would be a per-student amount — left out then.
        await audit(tx, actorOf(ctx), { action: "fee_opening.import", entityType: "AcademicSession", entityId: input.academicSessionId, after: { classId: input.classId, created: rows.length, skipped, first: rows[0].invoiceNo, last: rows[rows.length - 1].invoiceNo, ...(rows.length >= 3 ? { total } : {}), dueOn: input.dueOn } });
        return { created: rows.length, skipped, total };
      },
      { timeout: 60_000 },
    );
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (isUniqueViolation(e, "invoiceNo")) throw new ConflictError("An invoice number made with the current format already exists. Change the invoice number format and try again.");
    if (isUniqueViolation(e)) throw new ConflictError("Previous dues were added meanwhile. Upload the file again.");
    if (isTransactionBusy(e)) throw new ServiceBusyError();
    if (e instanceof Error && /^Missing value for \{/.test(e.message)) throw new ConflictError("The invoice number format needs the school short code. Set it in Settings.");
    throw e;
  }
}
