import Decimal from "decimal.js";

/**
 * Phase 4B-M4/M5 — marks entry and the marks-sheet workflow (pure; PHASE_4_PLAN.md AC10, AC13).
 *
 * A marks sheet holds one exam subject for one section. OPEN (the allocated teacher enters marks) → SUBMITTED (the
 * teacher hands it in; read-only) → APPROVED (a `marks.approve` holder who neither submitted nor entered marks on it).
 * The approver may return a SUBMITTED sheet to OPEN. An APPROVED sheet is corrected only by a `marks.approve` holder,
 * with a reason, and only until the results are published (the report cards are a snapshot — AC15).
 *
 * Marks: whole or half marks per part, each ≤ its maximum; a part with maximum 0 is not examined and stays blank.
 * AB (absent) and EX (exempt) carry no marks (DB CHECK examination_marks_status_check).
 */
export type SheetStatus = "OPEN" | "SUBMITTED" | "APPROVED";
export type MarkStatus = "PRESENT" | "ABSENT" | "EXEMPT";
export type ExamStatus = "DRAFT" | "SCHEDULED" | "MARKS_ENTRY" | "LOCKED" | "PUBLISHED";

export const SHEET_STATUS_LABEL: Record<SheetStatus, string> = { OPEN: "Open", SUBMITTED: "Submitted", APPROVED: "Approved" };
export const MARK_STATUS_LABEL: Record<MarkStatus, string> = { PRESENT: "Present", ABSENT: "AB", EXEMPT: "EX" };

export interface Maxima {
  theory: number;
  practical: number;
  internal: number;
}

export interface MarkEntry {
  status: MarkStatus;
  theory: string | null;
  practical: string | null;
  internal: string | null;
}

const MARK_RE = /^\d{1,4}(\.5|\.0)?$/;
const PARTS = [
  ["theory", "Theory"],
  ["practical", "Practical"],
  ["internal", "Internal"],
] as const;

/**
 * Returns a user-facing problem with one student's marks, or null. `partial` allows blanks for PRESENT (a teacher may
 * save half-entered work while the sheet is OPEN); submission, approval and corrections require complete marks.
 */
export function entryProblem(entry: MarkEntry, max: Maxima, partial: boolean): string | null {
  for (const [key, label] of PARTS) {
    const v = entry[key];
    if (entry.status !== "PRESENT") {
      if (v !== null) return `${label}: leave marks blank for ${MARK_STATUS_LABEL[entry.status]}.`;
      continue;
    }
    if (max[key] === 0) {
      if (v !== null) return `${label} isn't examined in this subject.`;
      continue;
    }
    if (v === null) {
      if (partial) continue;
      return `${label} marks are missing.`;
    }
    if (!MARK_RE.test(v)) return `${label}: use whole or half marks (e.g. 42 or 42.5).`;
    if (new Decimal(v).gt(max[key])) return `${label}: ${v} is more than the maximum ${max[key]}.`;
  }
  return null;
}

/** Same value? (marks compared numerically: "42" = "42.0"). */
export function sameEntry(a: MarkEntry, b: MarkEntry): boolean {
  if (a.status !== b.status) return false;
  return PARTS.every(([k]) => (a[k] === null ? b[k] === null : b[k] !== null && new Decimal(a[k]).eq(b[k])));
}

export interface SheetFacts {
  examStatus: ExamStatus;
  sheetStatus: SheetStatus | null;
}

/** May marks be entered / changed by the allocated teacher (no reason) right now? */
export function teacherCanEdit(f: SheetFacts): boolean {
  return f.examStatus === "MARKS_ENTRY" && (f.sheetStatus === null || f.sheetStatus === "OPEN");
}

/** May a marks.approve holder correct an APPROVED sheet (with a reason)? Not once results are published. */
export function approverCanCorrect(f: SheetFacts): boolean {
  return f.sheetStatus === "APPROVED" && (f.examStatus === "MARKS_ENTRY" || f.examStatus === "LOCKED");
}

export type SheetAction = "submit" | "return" | "approve";

/** Returns a user-facing reason a workflow step is refused, or null. */
export function sheetActionProblem(
  action: SheetAction,
  f: SheetFacts & { rosterCount: number; completeCount: number; actorSubmitted: boolean; actorEntered: boolean },
): string | null {
  if (f.examStatus !== "MARKS_ENTRY") return "The exam isn't open for marks entry.";
  if (action === "submit") {
    if (f.sheetStatus !== "OPEN") return "Only an open marks sheet can be submitted.";
    if (f.rosterCount === 0) return "No students take this subject in this section.";
    if (f.completeCount < f.rosterCount) return `Marks are missing for ${f.rosterCount - f.completeCount} student(s). Enter marks, AB or EX for everyone first.`;
    return null;
  }
  if (f.sheetStatus !== "SUBMITTED") return "Only a submitted marks sheet can be approved or returned.";
  if (action === "approve") {
    // AC13: maker-checker — the approver is never the teacher who entered or submitted the marks.
    if (f.actorSubmitted || f.actorEntered) return "You entered or submitted these marks, so someone else must approve them.";
    if (f.completeCount < f.rosterCount) return "Students were added after submission; return the sheet so their marks can be entered.";
  }
  return null;
}

export interface RequiredSheet {
  label: string;
  rosterCount: number;
  sheet: { status: SheetStatus; markCount: number } | null;
}

/**
 * Locking the exam's marks (MARKS_ENTRY → LOCKED) requires every exam subject × section that has students to have an
 * APPROVED sheet with a mark row for each of them. Returns up to 5 problems (empty = ready).
 */
export function lockProblems(required: readonly RequiredSheet[]): string[] {
  const out: string[] = [];
  for (const r of required) {
    if (r.rosterCount === 0) continue;
    if (!r.sheet) out.push(`${r.label}: no marks entered.`);
    else if (r.sheet.status !== "APPROVED") out.push(`${r.label}: ${SHEET_STATUS_LABEL[r.sheet.status].toLowerCase()}, not approved.`);
    else if (r.sheet.markCount < r.rosterCount) out.push(`${r.label}: marks missing for ${r.rosterCount - r.sheet.markCount} student(s).`);
    if (out.length === 5) break;
  }
  return out;
}

/** Decimal(5,1) from the database → a canonical mark string ("42", "42.5"), or null. */
export function markString(v: { toString(): string } | null): string | null {
  if (v === null) return null;
  return new Decimal(v.toString()).toString();
}
