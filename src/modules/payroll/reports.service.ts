import Decimal from "decimal.js";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { authorize, type AuthContext } from "@/lib/rbac/authorize";

/**
 * Phase 3C-M6 — payroll reports. `payroll.read`; CSV also `export.run`. Amounts are payroll data (readers see them
 * anyway); PAN / bank details are NEVER included (KI-088). Every cell goes through lib/csv (formula-safe). Exports are
 * audited with the run, the row count and the format only.
 */
const actorOf = (ctx: AuthContext): AuditActor => ({ userId: ctx.userId, label: ctx.username, ipHash: ctx.ipHash, requestId: ctx.requestId });
const MAX_ROWS = 5000;

type Line = { code: string; name: string; amount: string };
const lines = (v: unknown): Line[] => (Array.isArray(v) ? (v as Line[]).filter((l) => l && typeof l.code === "string") : []);

export const REGISTER_HEADER = [
  "Slip no", "Employee ID", "Name", "Department", "Designation", "Month days", "Not on rolls", "LOP days", "Paid days",
  "Gross", "Deductions", "Net", "Paid", "Due",
] as const;

/** Earnings / deductions totalled by component across the run's slips (adjustments grouped by kind). */
export async function getRunComponentTotals(ctx: AuthContext, runId: string) {
  authorize(ctx, "payroll.read");
  const slips = await prisma.payrollSlip.findMany({
    where: { runId },
    take: MAX_ROWS,
    select: { earnings: true, deductions: true, adjustments: { select: { kind: true, amount: true } } },
  });
  const earn = new Map<string, { name: string; total: Decimal }>();
  const ded = new Map<string, { name: string; total: Decimal }>();
  const add = (m: typeof earn, key: string, name: string, amount: Decimal.Value) => {
    const cur = m.get(key) ?? { name, total: new Decimal(0) };
    cur.total = cur.total.plus(amount);
    m.set(key, cur);
  };
  const ADJ: Record<string, string> = { BONUS: "Bonus", ARREARS: "Arrears", OTHER_EARNING: "Other earnings", OTHER_DEDUCTION: "Other deductions" };
  for (const s of slips) {
    for (const l of lines(s.earnings)) add(earn, l.code, l.name, l.amount);
    for (const l of lines(s.deductions)) add(ded, l.code, l.name, l.amount);
    for (const a of s.adjustments) add(a.kind === "OTHER_DEDUCTION" ? ded : earn, `ADJ:${a.kind}`, ADJ[a.kind], a.amount.toString());
  }
  const out = (m: typeof earn) => [...m.entries()].map(([code, v]) => ({ code, name: v.name, total: v.total.toFixed(2) }));
  return { earnings: out(earn), deductions: out(ded) };
}

/** The run register as CSV (one row per slip). */
export async function exportRunRegister(ctx: AuthContext, runId: string): Promise<{ csv: string; month: string; rows: number }> {
  authorize(ctx, "payroll.read");
  authorize(ctx, "export.run");
  const run = await prisma.payrollRun.findUnique({ where: { id: runId }, select: { id: true, month: true, status: true } });
  if (!run) throw new NotFoundError("Payroll run not found.");
  if (run.status === "DRAFT") throw new ValidationError("Prepare the payroll before exporting it.");
  const slips = await prisma.payrollSlip.findMany({
    where: { runId },
    orderBy: [{ employee: { fullName: "asc" } }, { id: "asc" }],
    take: MAX_ROWS + 1,
    select: {
      slipNo: true,
      monthDays: true,
      offRollsDays: true,
      lopDays: true,
      paidDays: true,
      gross: true,
      totalDeductions: true,
      net: true,
      employee: { select: { employeeCode: true, fullName: true, department: { select: { name: true } }, designation: { select: { name: true } } } },
      payments: { select: { amount: true } },
    },
  });
  if (slips.length > MAX_ROWS) throw new ConflictError(`More than ${MAX_ROWS} slips — too many for one export.`);
  const csv = toCsv(
    REGISTER_HEADER,
    slips.map((s) => {
      const paid = s.payments.reduce((t, p) => t.plus(p.amount.toString()), new Decimal(0));
      return [
        s.slipNo ?? "",
        s.employee.employeeCode,
        s.employee.fullName,
        s.employee.department.name,
        s.employee.designation.name,
        s.monthDays,
        s.offRollsDays,
        s.lopDays.toString(),
        s.paidDays.toString(),
        s.gross.toFixed(2),
        s.totalDeductions.toFixed(2),
        s.net.toFixed(2),
        paid.toFixed(2),
        new Decimal(s.net.toString()).minus(paid).toFixed(2),
      ];
    }),
  );
  const month = run.month.toISOString().slice(0, 7);
  await prisma.$transaction((tx) =>
    audit(tx, actorOf(ctx), { action: "payroll_run.export", entityType: "PayrollRun", entityId: run.id, after: { month, status: run.status, rows: slips.length, format: "csv" } }),
  );
  return { csv, month, rows: slips.length };
}
