import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import type { AuthContext } from "@/lib/rbac/authorize";
import { assertFeeReports } from "./fees.policy";
import { gapLabel, type NumberGap } from "./report-rows";

/**
 * Phase 5C-M2 — reconciliation (PHASE_5_PLAN.md 5C-M2, FC8, R3). Read-only invariant checks over the fee tables,
 * `fee.report` at ALL. Each check is one bounded SQL aggregate: a problem COUNT plus at most 20 samples that are
 * receipt / invoice numbers only (no names, amounts or references). The database CHECKs already hold per row
 * (status ↔ amounts, total = subtotal − concession + late fee); these checks cover what spans rows:
 *   1. every valid receipt = the sum of its live allocations; a cancelled receipt has none left;
 *   2. every invoice item's paid amount = its live allocations;
 *   3. every invoice's paid amount = its items' paid amounts;
 *   4. every invoice's subtotal / concession / late fee = its items (late fees outside the subtotal);
 *   5. collection by payment date and method = the live allocations of those receipts (the collection report's
 *      totals and the money actually put on invoices agree);
 *   6. receipt numbers and 7. invoice numbers have no gaps (lib/sequence hands out numbers inside the issuing
 *      transaction, so a rollback uses none; cancelled receipts and invoices keep theirs).
 * Running it is audited (who ran it and how many problems — no data).
 */
export interface ReconCheck {
  key: string;
  title: string;
  problems: number;
  samples: string[];
  explain: string;
}

const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const SAMPLES = 20;
type CountRow = { n: number };
type SampleRow = { s: string };

async function check(key: string, title: string, explain: string, count: Promise<CountRow[]>, samples: Promise<SampleRow[]>): Promise<ReconCheck> {
  const [[c], s] = await Promise.all([count, samples]);
  return { key, title, explain, problems: c?.n ?? 0, samples: c && c.n > 0 ? s.map((r) => r.s) : [] };
}

async function gaps(table: "fee_payment" | "fee_invoice"): Promise<{ count: number; samples: NumberGap[] }> {
  // Numbers ending in digits, grouped by everything before the digits (the format's prefix, e.g. "RCT/2026/").
  const rows =
    table === "fee_payment"
      ? await prisma.$queryRaw<{ p: string; gap_from: bigint; gap_to: bigint; width: number; total: bigint }[]>`
          WITH n AS (SELECT regexp_replace(receipt_no, '[0-9]+$', '') AS p, substring(receipt_no from '([0-9]+)$')::bigint AS k, length(substring(receipt_no from '([0-9]+)$')) AS w
                     FROM fee_payment WHERE receipt_no ~ '[0-9]+$'),
               g AS (SELECT p, k, w, lead(k) OVER (PARTITION BY p ORDER BY k) AS nxt FROM n)
          SELECT p, k + 1 AS gap_from, nxt - 1 AS gap_to, w AS width, sum(nxt - k - 1) OVER () AS total
          FROM g WHERE nxt > k + 1 ORDER BY p, k LIMIT ${SAMPLES}`
      : await prisma.$queryRaw<{ p: string; gap_from: bigint; gap_to: bigint; width: number; total: bigint }[]>`
          WITH n AS (SELECT regexp_replace(invoice_no, '[0-9]+$', '') AS p, substring(invoice_no from '([0-9]+)$')::bigint AS k, length(substring(invoice_no from '([0-9]+)$')) AS w
                     FROM fee_invoice WHERE invoice_no ~ '[0-9]+$'),
               g AS (SELECT p, k, w, lead(k) OVER (PARTITION BY p ORDER BY k) AS nxt FROM n)
          SELECT p, k + 1 AS gap_from, nxt - 1 AS gap_to, w AS width, sum(nxt - k - 1) OVER () AS total
          FROM g WHERE nxt > k + 1 ORDER BY p, k LIMIT ${SAMPLES}`;
  return { count: rows.length ? Number(rows[0].total) : 0, samples: rows.map((r) => ({ prefix: r.p, from: Number(r.gap_from), to: Number(r.gap_to), width: r.width })) };
}

export async function runReconciliation(ctx: AuthContext): Promise<{ checks: ReconCheck[]; problems: number; ranAt: string }> {
  assertFeeReports(ctx);
  const checks = await Promise.all([
    check(
      "payment-allocations",
      "Receipts = their allocations",
      "Each valid receipt's amount equals what it put on invoice lines; a cancelled receipt has nothing left on them.",
      prisma.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS n FROM fee_payment p
        LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.payment_id = p.id AND a.reversed_at IS NULL) x ON true
        WHERE (p.status = 'SUCCESS' AND x.live <> p.amount) OR (p.status = 'CANCELLED' AND x.live <> 0)`,
      prisma.$queryRaw<SampleRow[]>`
        SELECT p.receipt_no AS s FROM fee_payment p
        LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.payment_id = p.id AND a.reversed_at IS NULL) x ON true
        WHERE (p.status = 'SUCCESS' AND x.live <> p.amount) OR (p.status = 'CANCELLED' AND x.live <> 0)
        ORDER BY p.receipt_no LIMIT ${SAMPLES}`,
    ),
    check(
      "item-paid",
      "Invoice lines = their payments",
      "Each invoice line's paid amount equals the live payments allocated to it.",
      prisma.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS n FROM fee_invoice_item i
        LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.invoice_item_id = i.id AND a.reversed_at IS NULL) x ON true
        WHERE x.live <> i.paid_amount`,
      prisma.$queryRaw<SampleRow[]>`
        SELECT DISTINCT f.invoice_no AS s FROM fee_invoice_item i JOIN fee_invoice f ON f.id = i.invoice_id
        LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.invoice_item_id = i.id AND a.reversed_at IS NULL) x ON true
        WHERE x.live <> i.paid_amount ORDER BY 1 LIMIT ${SAMPLES}`,
    ),
    check(
      "invoice-paid",
      "Invoices = their lines (paid)",
      "Each invoice's paid amount equals the paid amounts of its lines.",
      prisma.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS n FROM fee_invoice f
        LEFT JOIN LATERAL (SELECT coalesce(sum(i.paid_amount), 0) AS paid FROM fee_invoice_item i WHERE i.invoice_id = f.id) x ON true
        WHERE x.paid <> f.paid_amount`,
      prisma.$queryRaw<SampleRow[]>`
        SELECT f.invoice_no AS s FROM fee_invoice f
        LEFT JOIN LATERAL (SELECT coalesce(sum(i.paid_amount), 0) AS paid FROM fee_invoice_item i WHERE i.invoice_id = f.id) x ON true
        WHERE x.paid <> f.paid_amount ORDER BY 1 LIMIT ${SAMPLES}`,
    ),
    check(
      "invoice-totals",
      "Invoices = their lines (amounts)",
      "Each invoice's subtotal, concession and late fee equal its lines (late fees are outside the subtotal).",
      prisma.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS n FROM fee_invoice f
        LEFT JOIN LATERAL (SELECT coalesce(sum(i.amount) FILTER (WHERE i.kind <> 'LATE_FEE'), 0) AS sub, coalesce(sum(i.concession_amount), 0) AS con,
                                  coalesce(sum(i.amount) FILTER (WHERE i.kind = 'LATE_FEE'), 0) AS late FROM fee_invoice_item i WHERE i.invoice_id = f.id) x ON true
        WHERE x.sub <> f.subtotal OR x.con <> f.concession_total OR x.late <> f.late_fee`,
      prisma.$queryRaw<SampleRow[]>`
        SELECT f.invoice_no AS s FROM fee_invoice f
        LEFT JOIN LATERAL (SELECT coalesce(sum(i.amount) FILTER (WHERE i.kind <> 'LATE_FEE'), 0) AS sub, coalesce(sum(i.concession_amount), 0) AS con,
                                  coalesce(sum(i.amount) FILTER (WHERE i.kind = 'LATE_FEE'), 0) AS late FROM fee_invoice_item i WHERE i.invoice_id = f.id) x ON true
        WHERE x.sub <> f.subtotal OR x.con <> f.concession_total OR x.late <> f.late_fee ORDER BY 1 LIMIT ${SAMPLES}`,
    ),
    check(
      "collection-by-day-method",
      "Collection report = money on invoices",
      "For every payment date and method, valid receipts total the same as their live allocations.",
      prisma.$queryRaw<CountRow[]>`
        SELECT count(*)::int AS n FROM (
          SELECT p.paid_on, p.method FROM fee_payment p
          LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.payment_id = p.id AND a.reversed_at IS NULL) x ON true
          WHERE p.status = 'SUCCESS' GROUP BY p.paid_on, p.method HAVING sum(p.amount) <> sum(x.live)) d`,
      prisma.$queryRaw<SampleRow[]>`
        SELECT to_char(p.paid_on, 'YYYY-MM-DD') || ' ' || p.method::text AS s FROM fee_payment p
        LEFT JOIN LATERAL (SELECT coalesce(sum(a.amount), 0) AS live FROM fee_payment_allocation a WHERE a.payment_id = p.id AND a.reversed_at IS NULL) x ON true
        WHERE p.status = 'SUCCESS' GROUP BY p.paid_on, p.method HAVING sum(p.amount) <> sum(x.live) ORDER BY 1 LIMIT ${SAMPLES}`,
    ),
    gaps("fee_payment").then((g) => ({ key: "receipt-gaps", title: "Receipt numbers without gaps", explain: "Receipt numbers run on without a missing number (cancelled receipts keep theirs).", problems: g.count, samples: g.samples.map(gapLabel) })),
    gaps("fee_invoice").then((g) => ({ key: "invoice-gaps", title: "Invoice numbers without gaps", explain: "Invoice numbers run on without a missing number (cancelled invoices keep theirs).", problems: g.count, samples: g.samples.map(gapLabel) })),
  ]);
  const problems = checks.reduce((s, c) => s + c.problems, 0);
  await prisma.$transaction((tx) => audit(tx, actorOf(ctx), { action: "fee_reconciliation.run", entityType: "FeeReport", entityId: "reconciliation", after: { problems, failed: checks.filter((c) => c.problems > 0).map((c) => c.key) } }));
  return { checks, problems, ranAt: new Date().toISOString() };
}
