import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Roll-number ordering and planning (pure — unit tested). Skill `roll-number-generation`, owner decision
 * D3: per section, alphabetical by full name; deterministic tie-breakers; finalized numbers never change
 * automatically (later admissions are APPENDED), corrections only explicitly.
 *
 * Sorting happens HERE, not in SQL, so the result never depends on the database collation.
 */
const collator = new Intl.Collator("en-IN", { sensitivity: "base", numeric: true, ignorePunctuation: true });

/** NFC, trimmed, single spaces — the comparison key (case/accents handled by the collator). */
export function rollNameKey(fullName: string): string {
  return fullName.normalize("NFC").trim().replace(/\s+/g, " ");
}

export interface RollCandidate {
  enrollmentId: string;
  fullName: string;
  dob: Date;
  studentCode: string;
}

/**
 * Name (case-, accent- and punctuation-insensitive; "Class 2" < "Class 10") → date of birth (older first)
 * → student ID (unique, compared by code point so the order is total and machine-independent).
 */
export function compareForRoll(a: RollCandidate, b: RollCandidate): number {
  return (
    collator.compare(rollNameKey(a.fullName), rollNameKey(b.fullName)) ||
    a.dob.getTime() - b.dob.getTime() ||
    (a.studentCode < b.studentCode ? -1 : a.studentCode > b.studentCode ? 1 : 0)
  );
}

export function orderForRollNumbers<T extends RollCandidate>(rows: T[]): (T & { rollNumber: number })[] {
  return [...rows].sort(compareForRoll).map((r, i) => ({ ...r, rollNumber: i + 1 }));
}

/**
 * A draft may be finalized only if it still equals what generation would produce now: the same ACTIVE
 * enrollments in the same order (names or dates edited, or a student admitted/left since → generate again).
 */
export function draftMatchesCurrent(draft: { enrollmentId: string; rollNumber: number }[], current: RollCandidate[]): boolean {
  const expected = orderForRollNumbers(current);
  if (expected.length !== draft.length) return false;
  const byEnrollment = new Map(draft.map((d) => [d.enrollmentId, d.rollNumber]));
  return expected.every((e) => byEnrollment.get(e.enrollmentId) === e.rollNumber);
}

/**
 * Next number for a late admission in a FINALIZED section: one past the highest number EVER given in the
 * batch (including students who left), so a number is never reused within the session.
 */
export function nextAppendedNumber(existingNumbers: number[]): number {
  return existingNumbers.length ? Math.max(...existingNumbers) + 1 : 1;
}

export const ROLL_NUMBER_MAX = 999;

/** A correction moves ONE student to a free number (1–999) in a finalized batch, with a reason. */
export function assertCorrection(input: { batchStatus: "DRAFT" | "FINALIZED"; current: number; target: number; takenBy: string | null; enrollmentId: string }): void {
  if (input.batchStatus !== "FINALIZED") throw new ConflictError("Corrections apply to finalized roll numbers. Generate the draft again instead.");
  if (!Number.isInteger(input.target) || input.target < 1 || input.target > ROLL_NUMBER_MAX) {
    throw new ValidationError(`Use a roll number from 1 to ${ROLL_NUMBER_MAX}.`, [{ path: "rollNumber", message: "Out of range." }]);
  }
  if (input.target === input.current) throw new ValidationError("That is already the student's roll number.", [{ path: "rollNumber", message: "Unchanged." }]);
  if (input.takenBy && input.takenBy !== input.enrollmentId) {
    throw new ConflictError(`Roll number ${input.target} already belongs to another student. Choose a free number.`);
  }
}

/** Type-to-confirm for finalization: the section code, case-insensitive, surrounding spaces ignored. */
export function assertFinalizeConfirmation(typed: string, sectionCode: string): void {
  if (typed.trim().toUpperCase() !== sectionCode.toUpperCase()) {
    throw new ValidationError(`Type the section code ${sectionCode} to confirm.`, [{ path: "confirm", message: "Doesn't match the section code." }]);
  }
}
