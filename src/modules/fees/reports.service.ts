import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { ConflictError } from "@/lib/errors";
import { DEFAULT_SCHOOL_TIMEZONE, todayInTimeZone } from "@/lib/format";
import { moneyString, toMoney } from "@/lib/money";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";
import { sessionOptions } from "@/modules/academic/academic.tx";
import { readFeeSettingsTx } from "@/modules/settings/settings.service";
import { sessionEnrollmentsOf, studentLabels } from "@/modules/students/enrollment-reads.tx";
import { canExportGuardianContacts, canReadGuardianContacts, primaryGuardianContacts } from "@/modules/students/guardian-contacts.tx";
import { assertFeeReports } from "./fees.policy";
import { concessionValueText, daysBefore, daysBetween, groupOutstandingByClass, REMOVED, sumColumn, waiverAmount, type StudentInvoiceAgg } from "./report-rows";
import { REPORT_LABEL, type ReportQuery } from "./reports.schemas";

/**
 * Phase 5C-M1 — fee reports (PHASE_5_PLAN.md FC20, R4, R5; §13 5C, §15 M2). Read-only, `fee.report` at ALL.
 * - Every report is one table (header, rows, totals) shared by the page and the CSV export, at most 5,000 rows
 *   (more → refused, never truncated). Aggregates run in SQL over fee tables only; names, classes and guardian
 *   contacts come from the students module (§2: fees never reads student tables directly).
 * - Never in a report: cancel / concession / waiver reasons (§11 I4), references (UPI / cheque / card), Aadhaar,
 *   addresses. Defaulters list the primary guardian's name and phone (FC20) on the page for callers with whole-school
 *   `student.read`, and in a CSV only when the caller also passes the student-export rule (`admission.read` ALL, D8;
 *   review 5C-M1 M1: the Accountant's CSV has no contacts).
 * - CSV export: also `export.run`, formula-safe (`lib/csv`), audited with the report name, the filters used and the
 *   row count — never the data.
 */
export const REPORT_MAX_ROWS = 5000;
/** Review 5C-M1 L1: students aggregated for "outstanding by class" (grouped before display; bounded all the same). */
export const OUTSTANDING_MAX_STUDENTS = 20000;

export interface ReportTable {
  title: string;
  header: string[];
  rows: string[][];
  totals: string[] | null;
  notes: string[];
}

const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const METHOD_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", BANK_TRANSFER: "Bank transfer", CHEQUE: "Cheque", CARD: "Card" };
const STATUS_LABEL: Record<string, string> = { PROPOSED: "Proposed", APPROVED: "Approved", REJECTED: "Rejected", REVOKED: "Revoked" };
const tooMany = () => new ConflictError(`This report has more than ${REPORT_MAX_ROWS.toLocaleString("en-IN")} rows. Narrow the filters and try again.`);
const isoOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

async function schoolTz(): Promise<string> {
  return (await readFeeSettingsTx(prisma as unknown as Tx)).timezone ?? DEFAULT_SCHOOL_TIMEZONE;
}

type Agg = { k: string; n: number; t: string };

async function collection(q: ReportQuery): Promise<ReportTable> {
  const from = q.from!;
  const to = q.to!;
  let rows: Agg[];
  let label: string;
  if (q.groupBy === "method") {
    label = "Method";
    rows = await prisma.$queryRaw<Agg[]>`SELECT method::text AS k, count(*)::int AS n, sum(amount)::text AS t FROM fee_payment WHERE status = 'SUCCESS' AND paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 1`;
    rows = rows.map((r) => ({ ...r, k: METHOD_LABEL[r.k] ?? r.k }));
  } else if (q.groupBy === "collector") {
    label = "Collected by";
    rows = await prisma.$queryRaw<Agg[]>`
      SELECT coalesce(u.display_name, '(removed user)') AS k, count(*)::int AS n, sum(p.amount)::text AS t
      FROM fee_payment p LEFT JOIN "user" u ON u.id = p.collected_by_id
      WHERE p.status = 'SUCCESS' AND p.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 1`;
  } else if (q.groupBy === "category") {
    label = "Fee head";
    rows = await prisma.$queryRaw<Agg[]>`
      SELECT c.name AS k, count(DISTINCT a.payment_id)::int AS n, sum(a.amount)::text AS t
      FROM fee_payment_allocation a JOIN fee_payment p ON p.id = a.payment_id
      JOIN fee_invoice_item i ON i.id = a.invoice_item_id JOIN fee_category c ON c.id = i.category_id
      WHERE a.reversed_at IS NULL AND p.status = 'SUCCESS' AND p.paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 1`;
  } else {
    label = "Date";
    rows = await prisma.$queryRaw<Agg[]>`SELECT to_char(paid_on, 'YYYY-MM-DD') AS k, count(*)::int AS n, sum(amount)::text AS t FROM fee_payment WHERE status = 'SUCCESS' AND paid_on BETWEEN ${from}::date AND ${to}::date GROUP BY 1 ORDER BY 1`;
  }
  const [tot] = await prisma.$queryRaw<{ n: number; t: string; c: number }[]>`
    SELECT count(*) FILTER (WHERE status = 'SUCCESS')::int AS n, coalesce(sum(amount) FILTER (WHERE status = 'SUCCESS'), 0)::text AS t,
           count(*) FILTER (WHERE status = 'CANCELLED')::int AS c
    FROM fee_payment WHERE paid_on BETWEEN ${from}::date AND ${to}::date`;
  const notes = [`Payment dates ${from} to ${to}. Cancelled receipts are not counted.`];
  if (tot.c > 0) notes.push(`${tot.c} receipt${tot.c === 1 ? "" : "s"} with a payment date in this period ${tot.c === 1 ? "was" : "were"} cancelled (see Cancelled receipts).`);
  if (q.groupBy === "category") notes.push("A receipt that paid several fee heads is counted under each of them; the total counts it once.");
  return {
    title: `Collection by ${label.toLowerCase()}`,
    header: [label, "Receipts", "Amount (Rs.)"],
    rows: rows.map((r) => [r.k, String(r.n), moneyString(r.t)]),
    totals: ["Total", String(tot.n), moneyString(tot.t)],
    notes,
  };
}

async function outstanding(q: ReportQuery): Promise<ReportTable> {
  const sid = q.academicSessionId!;
  const notes = ["Live invoices of the session (cancelled invoices excluded). Late fees not yet charged are not included."];
  if (q.by === "installment") {
    const rows = await prisma.$queryRaw<{ k: string; due: string; n: number; open: number; total: string; paid: string }[]>`
      SELECT coalesce(fi.name, 'Previous dues') AS k, to_char(min(f.due_on), 'YYYY-MM-DD') AS due, count(*)::int AS n,
             count(*) FILTER (WHERE f.total > f.paid_amount)::int AS open, sum(f.total)::text AS total, sum(f.paid_amount)::text AS paid
      FROM fee_invoice f LEFT JOIN fee_installment fi ON fi.id = f.installment_id
      WHERE f.academic_session_id = ${sid} AND f.deleted_at IS NULL
      GROUP BY fi.id, fi.name, fi.sort_order ORDER BY min(f.due_on), fi.sort_order NULLS FIRST`;
    const out = rows.map((r) => ({ ...r, total: moneyString(r.total), paid: moneyString(r.paid) }));
    return {
      title: "Outstanding by installment",
      header: ["Installment", "Due on", "Invoices", "Not fully paid", "Invoiced (Rs.)", "Received (Rs.)", "Balance (Rs.)"],
      rows: out.map((r) => [r.k, r.due, String(r.n), String(r.open), r.total, r.paid, subtract(r.total, r.paid)]),
      totals: totalsOf(out),
      notes,
    };
  }
  const per = await prisma.$queryRaw<{ sid: string; n: number; open: number; total: string; paid: string }[]>`
    SELECT student_id AS sid, count(*)::int AS n, count(*) FILTER (WHERE total > paid_amount)::int AS open, sum(total)::text AS total, sum(paid_amount)::text AS paid
    FROM fee_invoice WHERE academic_session_id = ${sid} AND deleted_at IS NULL GROUP BY student_id LIMIT ${OUTSTANDING_MAX_STUDENTS + 1}`;
  if (per.length > OUTSTANDING_MAX_STUDENTS) throw new ConflictError("This session has too many students for one report.");
  const roster = await sessionEnrollmentsOf(prisma, sid, per.map((p) => p.sid));
  const aggs: StudentInvoiceAgg[] = per.map((p) => ({ studentId: p.sid, invoices: p.n, open: p.open, total: p.total, paid: p.paid }));
  const groups = groupOutstandingByClass(aggs, roster);
  return {
    title: "Outstanding by class and section",
    header: ["Class", "Section", "Students", "Invoices", "Not fully paid", "Invoiced (Rs.)", "Received (Rs.)", "Balance (Rs.)"],
    rows: groups.map((g) => [g.className, g.sectionCode, String(g.students), String(g.invoices), String(g.open), g.total, g.paid, g.balance]),
    totals: ["Total", "", String(groups.reduce((s, g) => s + g.students, 0)), String(groups.reduce((s, g) => s + g.invoices, 0)), String(groups.reduce((s, g) => s + g.open, 0)), sumColumn(groups.map((g) => g.total)), sumColumn(groups.map((g) => g.paid)), sumColumn(groups.map((g) => g.balance))],
    notes,
  };
}

const subtract = (a: string, b: string) => moneyString(toMoney(a).minus(b));
function totalsOf(rows: { n: number; open: number; total: string; paid: string }[]): string[] {
  const total = sumColumn(rows.map((r) => r.total));
  const paid = sumColumn(rows.map((r) => r.paid));
  return ["Total", "", String(rows.reduce((s, r) => s + r.n, 0)), String(rows.reduce((s, r) => s + r.open, 0)), total, paid, subtract(total, paid)];
}

async function defaulters(ctx: AuthContext, q: ReportQuery, forExport: boolean): Promise<ReportTable> {
  const sid = q.academicSessionId!;
  const today = todayInTimeZone(await schoolTz());
  const cutoff = daysBefore(today, q.minDays);
  const per = await prisma.$queryRaw<{ sid: string; n: number; bal: string; oldest: string }[]>`
    SELECT student_id AS sid, count(*)::int AS n, sum(total - paid_amount)::text AS bal, to_char(min(due_on), 'YYYY-MM-DD') AS oldest
    FROM fee_invoice WHERE academic_session_id = ${sid} AND deleted_at IS NULL AND status IN ('ISSUED', 'PARTIAL') AND due_on <= ${cutoff}::date
    GROUP BY student_id LIMIT ${REPORT_MAX_ROWS + 1}`;
  if (per.length > REPORT_MAX_ROWS) throw tooMany();
  const ids = per.map((p) => p.sid);
  const contacts = forExport ? canExportGuardianContacts(ctx) : canReadGuardianContacts(ctx);
  const [roster, guardians] = await Promise.all([sessionEnrollmentsOf(prisma, sid, ids), contacts ? primaryGuardianContacts(prisma, ids) : Promise.resolve(new Map<string, { name: string; phone: string }>())]);
  const rows = per
    .map((p) => ({ p, r: roster.get(p.sid) }))
    .sort((a, b) => (a.r?.classLevel ?? 1e9) - (b.r?.classLevel ?? 1e9) || cmp(a.r?.className ?? "", b.r?.className ?? "") || cmp(a.r?.sectionCode ?? "", b.r?.sectionCode ?? "") || cmp(a.r?.fullName ?? "", b.r?.fullName ?? "") || cmp(a.p.sid, b.p.sid))
    .map(({ p, r }) => {
      const g = guardians.get(p.sid);
      const base = [r?.studentCode ?? "", r?.fullName ?? REMOVED, r?.className ?? "", r?.sectionCode ?? "", String(p.n), moneyString(p.bal), p.oldest, String(daysBetween(p.oldest, today))];
      return contacts ? [...base, g?.name ?? "", g?.phone ?? ""] : base;
    });
  const notes = [`Unpaid or part-paid invoices due on or before ${cutoff} (at least ${q.minDays} day${q.minDays === 1 ? "" : "s"} overdue on ${today}). Late fees not yet charged are not included.`];
  if (!contacts) notes.push(forExport ? "Guardian contacts are left out of downloads unless you may also export student records." : "Guardian contacts are shown only to staff who can see every student's record.");
  return {
    title: "Defaulters",
    header: ["Student ID", "Name", "Class", "Section", "Overdue invoices", "Balance (Rs.)", "Oldest due", "Days overdue", ...(contacts ? ["Primary guardian", "Phone"] : [])],
    rows,
    totals: ["Total", `${rows.length} student${rows.length === 1 ? "" : "s"}`, "", "", String(per.reduce((s, p) => s + p.n, 0)), sumColumn(per.map((p) => p.bal)), "", "", ...(contacts ? ["", ""] : [])],
    notes,
  };
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

async function concessions(q: ReportQuery): Promise<ReportTable> {
  const sid = q.academicSessionId!;
  const [list, waivers] = await Promise.all([
    prisma.studentConcession.findMany({
      where: { academicSessionId: sid },
      orderBy: [{ proposedAt: "asc" }, { id: "asc" }],
      take: REPORT_MAX_ROWS + 1,
      select: { studentId: true, status: true, proposedAt: true, decidedAt: true, concession: { select: { name: true, calc: true, value: true } }, proposedBy: { select: { displayName: true } }, decidedBy: { select: { displayName: true } } },
    }),
    // KI-105: late-fee waivers are zero LATE_FEE lines never allocated, whose text holds the amount (and the reason,
    // which is never shown here).
    prisma.feeInvoiceItem.findMany({
      where: { kind: "LATE_FEE", amount: 0, description: { startsWith: "Late fee ₹" }, allocations: { none: {} }, invoice: { academicSessionId: sid } },
      orderBy: { id: "asc" },
      take: REPORT_MAX_ROWS + 1,
      select: { description: true, invoice: { select: { studentId: true, invoiceNo: true, deletedAt: true } } },
    }),
  ]);
  if (list.length + waivers.length > REPORT_MAX_ROWS) throw tooMany();
  const roster = await sessionEnrollmentsOf(prisma, sid, [...new Set([...list.map((c) => c.studentId), ...waivers.map((w) => w.invoice.studentId)])]);
  const who = (id: string) => {
    const r = roster.get(id);
    return [r?.studentCode ?? "", r?.fullName ?? REMOVED, r ? `${r.className} ${r.sectionCode}` : ""];
  };
  const rows = [
    ...list.map((c) => ["Concession", ...who(c.studentId), c.concession.name, concessionValueText(c.concession.calc, c.concession.value.toString()), STATUS_LABEL[c.status] ?? c.status, c.proposedBy?.displayName ?? "(removed user)", isoOf(c.proposedAt), c.decidedBy?.displayName ?? (c.decidedAt ? "(removed user)" : ""), isoOf(c.decidedAt)]),
    ...waivers.map((w) => {
      const amount = waiverAmount(w.description);
      return ["Late-fee waiver", ...who(w.invoice.studentId), `Invoice ${w.invoice.invoiceNo}`, amount ? `Rs. ${amount}` : "", w.invoice.deletedAt ? "Waived (invoice cancelled)" : "Waived", "", "", "", ""];
    }),
  ];
  return {
    title: "Concession register",
    header: ["Type", "Student ID", "Name", "Class", "Concession / invoice", "Value", "Status", "Proposed by", "Proposed on", "Decided by", "Decided on"],
    rows,
    totals: null,
    notes: ["Every concession proposed in the session with who proposed and who decided it, and every late-fee waiver. Reasons are kept on the record and are not listed here. Who waived a late fee is in the audit log."],
  };
}

async function cancelledReceipts(q: ReportQuery): Promise<ReportTable> {
  const tz = await schoolTz();
  const rows = await prisma.$queryRaw<{ receipt_no: string; paid_on: string; student_id: string; amount: string; method: string; collector: string; canceller: string; cancelled_at: string }[]>`
    SELECT p.receipt_no, to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on, p.student_id, p.amount::text AS amount, p.method::text AS method,
           coalesce(c.display_name, '(removed user)') AS collector, coalesce(x.display_name, '(removed user)') AS canceller,
           to_char(p.cancelled_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS cancelled_at
    FROM fee_payment p LEFT JOIN "user" c ON c.id = p.collected_by_id LEFT JOIN "user" x ON x.id = p.cancelled_by_id
    WHERE p.status = 'CANCELLED' AND (p.cancelled_at AT TIME ZONE ${tz})::date BETWEEN ${q.from!}::date AND ${q.to!}::date
    ORDER BY p.cancelled_at, p.id LIMIT ${REPORT_MAX_ROWS + 1}`;
  if (rows.length > REPORT_MAX_ROWS) throw tooMany();
  const labels = await studentLabels(prisma, [...new Set(rows.map((r) => r.student_id))]);
  return {
    title: "Cancelled receipts",
    header: ["Receipt", "Payment date", "Student ID", "Name", "Amount (Rs.)", "Method", "Collected by", "Cancelled by", "Cancelled at"],
    rows: rows.map((r) => [r.receipt_no, r.paid_on, labels.get(r.student_id)?.studentCode ?? "", labels.get(r.student_id)?.fullName ?? REMOVED, moneyString(r.amount), METHOD_LABEL[r.method] ?? r.method, r.collector, r.canceller, r.cancelled_at]),
    totals: ["Total", "", "", `${rows.length} receipt${rows.length === 1 ? "" : "s"}`, sumColumn(rows.map((r) => r.amount)), "", "", "", ""],
    notes: [`Cancelled between ${q.from} and ${q.to} (school time). The reason is on each receipt's page (people who can cancel receipts only).`],
  };
}

async function cancelledInvoices(q: ReportQuery): Promise<ReportTable> {
  const sid = q.academicSessionId!;
  const tz = await schoolTz();
  // §13: cancelled invoices with no live replacement for the same student, session, kind and installment.
  const rows = await prisma.$queryRaw<{ invoice_no: string; student_id: string; inst: string; total: string; cancelled_at: string; canceller: string }[]>`
    SELECT f.invoice_no, f.student_id, coalesce(fi.name, 'Previous dues') AS inst, f.total::text AS total,
           to_char(f.cancelled_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS cancelled_at, coalesce(u.display_name, '(removed user)') AS canceller
    FROM fee_invoice f LEFT JOIN fee_installment fi ON fi.id = f.installment_id LEFT JOIN "user" u ON u.id = f.cancelled_by_id
    WHERE f.academic_session_id = ${sid} AND f.status = 'CANCELLED'
      AND NOT EXISTS (SELECT 1 FROM fee_invoice g WHERE g.student_id = f.student_id AND g.academic_session_id = f.academic_session_id
                      AND g.deleted_at IS NULL AND g.kind = f.kind AND g.installment_id IS NOT DISTINCT FROM f.installment_id)
    ORDER BY f.cancelled_at, f.id LIMIT ${REPORT_MAX_ROWS + 1}`;
  if (rows.length > REPORT_MAX_ROWS) throw tooMany();
  const roster = await sessionEnrollmentsOf(prisma, sid, [...new Set(rows.map((r) => r.student_id))]);
  return {
    title: "Cancelled invoices not issued again",
    header: ["Invoice", "Student ID", "Name", "Class", "Installment", "Amount (Rs.)", "Cancelled at", "Cancelled by"],
    rows: rows.map((r) => {
      const s = roster.get(r.student_id);
      return [r.invoice_no, s?.studentCode ?? "", s?.fullName ?? REMOVED, s ? `${s.className} ${s.sectionCode}` : "", r.inst, moneyString(r.total), r.cancelled_at, r.canceller];
    }),
    totals: ["Total", "", `${rows.length} invoice${rows.length === 1 ? "" : "s"}`, "", "", sumColumn(rows.map((r) => r.total)), "", ""],
    notes: ["An invoice cancelled and never issued again is money the school no longer asks for — check each one has a reason."],
  };
}

async function build(ctx: AuthContext, q: ReportQuery, forExport = false): Promise<ReportTable> {
  let t: ReportTable;
  switch (q.report) {
    case "collection":
      t = await collection(q);
      break;
    case "outstanding":
      t = await outstanding(q);
      break;
    case "defaulters":
      t = await defaulters(ctx, q, forExport);
      break;
    case "concessions":
      t = await concessions(q);
      break;
    case "cancelled-receipts":
      t = await cancelledReceipts(q);
      break;
    case "cancelled-invoices":
      t = await cancelledInvoices(q);
      break;
  }
  if (t.rows.length > REPORT_MAX_ROWS) throw tooMany();
  return t;
}

/** Sessions for the report filters, and today's school date (default date range). */
export async function feeReportOptions(ctx: AuthContext) {
  assertFeeReports(ctx);
  const [sessions, tz] = await Promise.all([sessionOptions(prisma), schoolTz()]);
  return { sessions: sessions.map((s) => ({ id: s.id, name: s.name, status: s.status, isCurrent: s.isCurrent })), today: todayInTimeZone(tz) };
}

/** A fee report for the page. */
export async function runFeeReport(ctx: AuthContext, q: ReportQuery): Promise<ReportTable> {
  assertFeeReports(ctx);
  return build(ctx, q);
}

/** The same report as CSV (`fee.report` + `export.run`), formula-safe, audited without the data. */
export async function exportFeeReport(ctx: AuthContext, q: ReportQuery): Promise<{ csv: string; rows: number; fileName: string }> {
  authorize(ctx, "export.run");
  assertFeeReports(ctx);
  const t = await build(ctx, q, true);
  const csv = toCsv(t.header, t.totals ? [...t.rows, t.totals] : t.rows);
  // Review L2: the filter VALUES (session id, dates, grouping; nothing personal), so the audit says what was exported.
  const filters = { academicSessionId: q.academicSessionId ?? null, from: q.from ?? null, to: q.to ?? null, groupBy: q.groupBy, by: q.by, minDays: q.minDays };
  await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "fee_report.export", entityType: "FeeReport", entityId: q.report, after: { report: q.report, filters, rows: t.rows.length, format: "csv", guardianContacts: t.header.includes("Phone") } }));
  return { csv, rows: t.rows.length, fileName: `fees-${q.report}-${new Date().toISOString().slice(0, 10)}.csv` };
}

export { REPORT_LABEL };
