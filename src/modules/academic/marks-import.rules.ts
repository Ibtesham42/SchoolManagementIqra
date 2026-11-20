import { entryProblem, sameEntry, type MarkEntry, type MarkStatus, type Maxima } from "./marks.rules";

/**
 * Phase 4C-M4 (AC19) — matching an uploaded marks table to one marks sheet. Pure; unit-tested.
 * - Header row = the first row; columns found by normalized name (the template's own headers, plus common variants).
 * - Students are matched by Student ID (permanent); a filled Roll No must agree with the sheet (catches shifted rows).
 * - A cell may hold a mark, AB (absent) or EX (exempt); a Status column, if present, may say the same.
 * - All-or-nothing: any problem → nothing can be confirmed (fix the file and upload again).
 * - Students not in the file stay as they are; rows equal to what's saved are skipped.
 * - A BLANK cell keeps the saved mark for that part (an import never clears marks — use the grid for that); a row
 *   marked AB / EX replaces the saved marks with the status.
 */
export interface ImportRosterRow {
  enrollmentId: string;
  studentCode: string;
  rollNumber: number | null;
  fullName: string;
  mark: (MarkEntry & { version: number }) | null;
}

export type ImportChange = "new" | "changed" | "same" | "blank";

export interface ImportPreviewRow {
  line: number;
  studentCode: string;
  fullName: string | null;
  entry: MarkEntry | null;
  change: ImportChange | null;
  problem: string | null;
}

export interface ImportEntry {
  enrollmentId: string;
  status: MarkStatus;
  theory: string | null;
  practical: string | null;
  internal: string | null;
  version: number | null;
}

export interface ImportPlan {
  fileProblem: string | null;
  rows: ImportPreviewRow[];
  entries: ImportEntry[];
  counts: { new: number; changed: number; same: number; blank: number; problems: number; notInFile: number };
}

export const TEMPLATE_HEADER = ["Student ID", "Roll No", "Name", "Theory", "Practical", "Internal"] as const;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES = {
  student: ["studentid", "studentcode", "id"],
  roll: ["rollno", "rollnumber", "roll"],
  theory: ["theory", "theorymarks", "written"],
  practical: ["practical", "practicalmarks"],
  internal: ["internal", "internalassessment", "internalmarks"],
  status: ["status", "attendance"],
} as const;
type Col = keyof typeof ALIASES;
const PARTS = [
  ["theory", "Theory"],
  ["practical", "Practical"],
  ["internal", "Internal"],
] as const;

export function findColumns(header: readonly string[]): Partial<Record<Col, number>> {
  const cols: Partial<Record<Col, number>> = {};
  header.forEach((h, i) => {
    const n = norm(h);
    for (const [col, names] of Object.entries(ALIASES) as [Col, readonly string[]][]) {
      if ((names as readonly string[]).includes(n)) {
        if (cols[col] !== undefined) return;
        cols[col] = i;
      }
    }
  });
  return cols;
}

type Cell = { kind: "blank" } | { kind: "mark"; value: string } | { kind: "status"; status: "ABSENT" | "EXEMPT" } | { kind: "bad" };

/** "42", "42.5", "42.50", 42.0 → canonical mark; AB / EX; anything else is bad. */
export function readMarkCell(raw: string): Cell {
  const s = raw.trim();
  if (s === "" || s === "-" || s === "—") return { kind: "blank" };
  const u = s.toUpperCase().replace(/\.$/, "");
  if (u === "AB" || u === "ABS" || u === "ABSENT" || u === "A") return { kind: "status", status: "ABSENT" };
  if (u === "EX" || u === "EXEMPT" || u === "EXEMPTED") return { kind: "status", status: "EXEMPT" };
  const m = /^(\d{1,4})(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) return { kind: "bad" };
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac !== "" && frac !== "5") return { kind: "bad" };
  return { kind: "mark", value: `${Number(m[1])}${frac === "5" ? ".5" : ""}` };
}

function readStatus(raw: string): MarkStatus | null | "bad" {
  const u = raw.trim().toUpperCase();
  if (u === "") return null;
  if (u === "P" || u === "PRESENT") return "PRESENT";
  if (u === "AB" || u === "ABS" || u === "ABSENT" || u === "A") return "ABSENT";
  if (u === "EX" || u === "EXEMPT" || u === "EXEMPTED") return "EXEMPT";
  return "bad";
}

/** One data row → the typed entry (not yet checked against the maxima), or a problem. */
export function rowEntry(row: readonly string[], cols: Partial<Record<Col, number>>): { entry: MarkEntry | null; problem: string | null } {
  const at = (i: number | undefined) => (i === undefined ? "" : (row[i] ?? ""));
  let status: MarkStatus | null = null;
  if (cols.status !== undefined) {
    const s = readStatus(at(cols.status));
    if (s === "bad") return { entry: null, problem: "Status: use P, AB or EX." };
    status = s;
  }
  const values: Record<"theory" | "practical" | "internal", string | null> = { theory: null, practical: null, internal: null };
  for (const [key, label] of PARTS) {
    const c = readMarkCell(at(cols[key]));
    if (c.kind === "bad") return { entry: null, problem: `${label}: "${at(cols[key]).slice(0, 20)}" isn't a mark (use e.g. 42, 42.5, AB or EX).` };
    if (c.kind === "status") {
      if (status !== null && status !== c.status) return { entry: null, problem: "Status and marks disagree (AB / EX)." };
      status = c.status;
    }
    if (c.kind === "mark") values[key] = c.value;
  }
  return { entry: { status: status ?? "PRESENT", ...values }, problem: null };
}

/** Blank cells keep the saved part (both present); otherwise the typed entry stands. */
export function mergeSaved(typed: MarkEntry, saved: MarkEntry | null): MarkEntry {
  if (!saved || typed.status !== "PRESENT" || saved.status !== "PRESENT") return typed;
  return { status: "PRESENT", theory: typed.theory ?? saved.theory, practical: typed.practical ?? saved.practical, internal: typed.internal ?? saved.internal };
}

/**
 * The whole plan. `partial` = the teacher's entry mode (blanks allowed); false = an approver's correction (every
 * listed student complete).
 */
export function planMarksImport(table: readonly (readonly string[])[], roster: readonly ImportRosterRow[], max: Maxima, partial: boolean): ImportPlan {
  const empty = (fileProblem: string): ImportPlan => ({ fileProblem, rows: [], entries: [], counts: { new: 0, changed: 0, same: 0, blank: 0, problems: 0, notInFile: roster.length } });
  if (table.length < 2) return empty("The file has no student rows below the header row.");
  const cols = findColumns(table[0]);
  if (cols.student === undefined) return empty('The header row needs a "Student ID" column (download the template to see the layout).');
  const missing = PARTS.filter(([k]) => max[k] > 0 && cols[k] === undefined).map(([, l]) => l);
  if (missing.length > 0) return empty(`The header row needs a column for: ${missing.join(", ")}.`);
  const byCode = new Map(roster.map((r) => [r.studentCode.toUpperCase(), r]));
  const seen = new Set<string>();
  const rows: ImportPreviewRow[] = [];
  const entries: ImportEntry[] = [];
  const counts = { new: 0, changed: 0, same: 0, blank: 0, problems: 0, notInFile: 0 };
  for (let i = 1; i < table.length; i++) {
    const row = table[i];
    const code = (row[cols.student] ?? "").trim();
    const out: ImportPreviewRow = { line: i + 1, studentCode: code, fullName: null, entry: null, change: null, problem: null };
    rows.push(out);
    const r = byCode.get(code.toUpperCase());
    if (code === "") out.problem = "Student ID is missing.";
    else if (!r) out.problem = "This student isn't on this marks sheet.";
    else if (seen.has(r.enrollmentId)) out.problem = "This student appears more than once in the file.";
    if (r) {
      out.fullName = r.fullName;
      seen.add(r.enrollmentId);
    }
    if (!out.problem && r && cols.roll !== undefined) {
      const roll = (row[cols.roll] ?? "").trim();
      if (roll !== "" && (r.rollNumber === null || String(r.rollNumber) !== roll.replace(/\.0+$/, ""))) out.problem = `Roll No ${roll.slice(0, 10)} doesn't match this student (rows may be shifted).`;
    }
    if (!out.problem && r) {
      const typed = rowEntry(row, cols);
      const entry = typed.entry ? mergeSaved(typed.entry, r.mark) : null;
      const problem = typed.problem ?? (entry ? entryProblem(entry, max, partial) : null);
      if (problem) out.problem = problem;
      else if (entry) {
        out.entry = entry;
        const blank = entry.status === "PRESENT" && entry.theory === null && entry.practical === null && entry.internal === null;
        out.change = r.mark ? (sameEntry(r.mark, entry) ? "same" : "changed") : blank ? "blank" : "new";
        if (out.change === "new" || out.change === "changed") entries.push({ enrollmentId: r.enrollmentId, ...entry, version: r.mark?.version ?? null });
      }
    }
    if (out.problem) counts.problems += 1;
    else if (out.change) counts[out.change] += 1;
  }
  counts.notInFile = roster.filter((r) => !seen.has(r.enrollmentId)).length;
  return { fileProblem: null, rows, entries, counts };
}
