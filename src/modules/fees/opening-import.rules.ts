import { MONEY_RE, moneyString, sumMoney, toMoney } from "@/lib/money";

/**
 * Phase 5C-M3 (FC19) — matching an uploaded opening-balance table (previous dues from the old system) to one class of
 * a session. Pure; unit tested.
 * - Header row = the first row; columns found by normalized name (the template's headers plus common variants).
 * - Students matched by Student ID (permanent); a filled Name must agree loosely (catches shifted rows).
 * - Amounts: digits with at most 2 decimals; "Rs.", "₹", spaces and Indian / western thousands commas allowed. Blank or
 *   0 = nothing to import. Above OPENING_MAX = a problem (typo guard).
 * - A student who already has previous dues in the session is skipped (one per student and session — cancel it on the
 *   student's fee page to change it). All-or-nothing: any problem → nothing can be confirmed.
 */
export const OPENING_TEMPLATE_HEADER = ["Student ID", "Name", "Class", "Section", "Previous dues (Rs.)"] as const;
export const OPENING_MAX = "1000000.00";

/** Review 5C-M3 L1: how far before today previous dues may fall due (a long-past date would charge the late-fee cap at once). */
export const OPENING_DUE_BACK_DAYS = 30;

/**
 * Review L1: the due date must lie inside the session (a far-future date would hide the dues from the defaulters list
 * and late fees) and be at most OPENING_DUE_BACK_DAYS before today. Returns a message, or null when allowed.
 */
export function openingDueProblem(dueOn: string, today: string, session: { startDate: string; endDate: string }): string | null {
  if (dueOn < session.startDate || dueOn > session.endDate) return `The due date must be within the academic session (${session.startDate} to ${session.endDate}).`;
  const earliest = new Date(Date.parse(`${today}T00:00:00Z`) - OPENING_DUE_BACK_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (dueOn < earliest) return `The due date can be at most ${OPENING_DUE_BACK_DAYS} days ago (late fees would be charged at once).`;
  return null;
}

export interface OpeningRosterRow {
  studentId: string;
  studentCode: string;
  fullName: string;
  /** Live previous-dues amount already in the session, or null. */
  existing: string | null;
}

export type OpeningRowStatus = "new" | "existing" | "blank" | "problem";

export interface OpeningPreviewRow {
  line: number;
  studentCode: string;
  fullName: string | null;
  amount: string | null;
  status: OpeningRowStatus;
  problem: string | null;
}

export interface OpeningEntry {
  studentId: string;
  amount: string;
}

export interface OpeningPlan {
  fileProblem: string | null;
  rows: OpeningPreviewRow[];
  entries: OpeningEntry[];
  counts: { new: number; existing: number; blank: number; problems: number; notInFile: number };
  total: string;
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const nameKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function findOpeningColumns(header: readonly string[]): { student?: number; name?: number; amount?: number } {
  const out: { student?: number; name?: number; amount?: number } = {};
  header.forEach((h, i) => {
    const n = norm(h);
    if (out.student === undefined && ["studentid", "studentcode", "id"].includes(n)) out.student = i;
    else if (out.name === undefined && ["name", "studentname", "fullname"].includes(n)) out.name = i;
    else if (out.amount === undefined && (n.startsWith("previousdues") || ["dues", "openingbalance", "balance", "amount"].includes(n))) out.amount = i;
  });
  return out;
}

/** "Rs. 1,25,000.50" → "125000.50"; blank → null; anything else → undefined (a problem). */
export function readAmount(raw: string): string | null | undefined {
  const v = raw.normalize("NFKC").trim().replace(/^(rs\.?|inr|₹)\s*/i, "").replace(/[\s,]/g, "");
  if (v === "" || v === "-") return null;
  if (!MONEY_RE.test(v)) return undefined;
  return moneyString(v);
}

export function planOpeningImport(table: readonly (readonly string[])[], roster: readonly OpeningRosterRow[]): OpeningPlan {
  const empty = (fileProblem: string): OpeningPlan => ({ fileProblem, rows: [], entries: [], counts: { new: 0, existing: 0, blank: 0, problems: 0, notInFile: roster.length }, total: "0.00" });
  if (table.length === 0) return empty("The file is empty.");
  const cols = findOpeningColumns(table[0]);
  if (cols.student === undefined || cols.amount === undefined) return empty('The file needs a "Student ID" column and a "Previous dues (Rs.)" column. Use the downloaded template.');
  const byCode = new Map(roster.map((r) => [r.studentCode.toUpperCase(), r]));
  const seen = new Set<string>();
  const rows: OpeningPreviewRow[] = [];
  const entries: OpeningEntry[] = [];
  const max = toMoney(OPENING_MAX);
  table.slice(1).forEach((row, i) => {
    const line = i + 2;
    const code = (row[cols.student!] ?? "").trim();
    const rawAmount = row[cols.amount!] ?? "";
    if (code === "" && rawAmount.trim() === "") return; // empty row
    const r = byCode.get(code.toUpperCase());
    const problem = (p: string) => rows.push({ line, studentCode: code, fullName: r?.fullName ?? null, amount: null, status: "problem", problem: p });
    if (!r) return problem("This student isn't in this class in the session.");
    if (seen.has(r.studentId)) return problem("This student appears more than once in the file.");
    seen.add(r.studentId);
    if (cols.name !== undefined) {
      const typed = nameKey(row[cols.name] ?? "");
      if (typed !== "" && typed !== nameKey(r.fullName)) return problem(`The name doesn't match this Student ID (expected ${r.fullName}).`);
    }
    const amount = readAmount(rawAmount);
    if (amount === undefined) return problem("Write the amount as digits, like 12500 or 12500.50.");
    if (amount === null || toMoney(amount).isZero()) {
      rows.push({ line, studentCode: r.studentCode, fullName: r.fullName, amount: null, status: "blank", problem: null });
      return;
    }
    if (toMoney(amount).gt(max)) return problem("The amount is more than ₹10,00,000. Check for a typo.");
    if (r.existing !== null) {
      rows.push({ line, studentCode: r.studentCode, fullName: r.fullName, amount, status: "existing", problem: null });
      return;
    }
    rows.push({ line, studentCode: r.studentCode, fullName: r.fullName, amount, status: "new", problem: null });
    entries.push({ studentId: r.studentId, amount });
  });
  const count = (s: OpeningRowStatus) => rows.filter((x) => x.status === s).length;
  return {
    fileProblem: null,
    rows,
    entries,
    counts: { new: count("new"), existing: count("existing"), blank: count("blank"), problems: count("problem"), notInFile: roster.filter((r) => !seen.has(r.studentId)).length },
    total: moneyString(sumMoney(entries.map((e) => e.amount))),
  };
}
