/**
 * Phase 4B-M3 — examination lifecycle rules (pure; PHASE_4_PLAN.md AC9, AC13).
 * DRAFT → SCHEDULED → MARKS_ENTRY → LOCKED → PUBLISHED. Steps back are allowed only before results exist:
 * SCHEDULED → DRAFT, and MARKS_ENTRY → SCHEDULED while no marks have been entered. LOCKED / PUBLISHED transitions
 * belong to the marks and results services (they need the sheets' state), not to setExamStatus.
 */
export type ExamStatus = "DRAFT" | "SCHEDULED" | "MARKS_ENTRY" | "LOCKED" | "PUBLISHED";

export const EXAM_STATUS_LABEL: Record<ExamStatus, string> = {
  DRAFT: "Draft",
  SCHEDULED: "Scheduled",
  MARKS_ENTRY: "Marks entry",
  LOCKED: "Locked",
  PUBLISHED: "Published",
};

/** Transitions setExamStatus may perform. */
const MANUAL: Record<ExamStatus, readonly ExamStatus[]> = {
  DRAFT: ["SCHEDULED"],
  SCHEDULED: ["DRAFT", "MARKS_ENTRY"],
  MARKS_ENTRY: ["SCHEDULED"],
  LOCKED: [],
  PUBLISHED: [],
};

export function manualTransitions(from: ExamStatus): readonly ExamStatus[] {
  return MANUAL[from];
}

export interface TransitionFacts {
  subjectCount: number;
  /** Marks rows already entered for this exam (any sheet). */
  marksCount: number;
}

/** Returns a user-facing reason the transition is refused, or null when it's allowed. */
export function transitionProblem(from: ExamStatus, to: ExamStatus, facts: TransitionFacts): string | null {
  if (!MANUAL[from].includes(to)) return `An exam can't move from ${EXAM_STATUS_LABEL[from]} to ${EXAM_STATUS_LABEL[to]}.`;
  if (to === "SCHEDULED" && from === "DRAFT" && facts.subjectCount === 0) return "Add at least one subject before scheduling the exam.";
  if (from === "MARKS_ENTRY" && to === "SCHEDULED" && facts.marksCount > 0) return "Marks have already been entered, so the exam can't go back to Scheduled.";
  return null;
}

/** Subjects (dates, maximum marks) can be changed only before marks entry starts. */
export function subjectsEditable(status: ExamStatus): boolean {
  return status === "DRAFT" || status === "SCHEDULED";
}

/** The grading scale can change only in DRAFT: from SCHEDULED on, the scale's bands are frozen for this exam. */
export function scaleEditable(status: ExamStatus): boolean {
  return status === "DRAFT";
}

/** A subject's exam date must fall within the exam's dates when those are set (ISO yyyy-mm-dd strings). */
export function dateProblem(examDate: string | null, start: string | null, end: string | null): string | null {
  if (!examDate) return null;
  if (start && examDate < start) return "The subject's exam date is before the exam starts.";
  if (end && examDate > end) return "The subject's exam date is after the exam ends.";
  return null;
}
