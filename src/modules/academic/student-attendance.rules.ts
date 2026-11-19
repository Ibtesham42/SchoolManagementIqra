import Decimal from "decimal.js";

/**
 * Pure Phase 4A student-attendance rules (no I/O — unit tested). PHASE_4_PLAN.md AC6, AC7.
 *
 * - School days: not a student weekly off, not a holiday for students (ALL / STUDENTS), within the enrollment window,
 *   up to today. Classification reuses the 3B calendar rules with the STUDENT weekly off.
 * - Attendance % = (present + late + ½ × half days) ÷ marked school days, half-up to 2 dp. EXCUSED counts as a day not
 *   attended (shown separately so the school can apply its own condonation rules — decision AC21, owner to confirm).
 *   Unmarked school days are reported, never guessed, and are not in the denominator.
 * - Corrections (AC7): the class teacher may change a mark on the same school day; later changes need academic.manage
 *   and a reason.
 */
export const STUDENT_STATUSES = ["PRESENT", "ABSENT", "LATE", "HALF_DAY", "EXCUSED"] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/** Holidays that are days off for STUDENTS. */
export const STUDENT_HOLIDAY_SCOPES = ["ALL", "STUDENTS"] as const;

export interface StudentMonthSummary {
  schoolDays: number;
  marked: number;
  unmarked: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  excused: number;
  /** null when nothing is marked yet. */
  percent: string | null;
}

export function summarizeStudentDays(
  days: readonly { date: string; kind: "working" | "weekly_off" | "holiday" }[],
  marks: ReadonlyMap<string, StudentStatus>,
  enrolled: (iso: string) => boolean,
  today: string,
): StudentMonthSummary {
  const s: StudentMonthSummary = { schoolDays: 0, marked: 0, unmarked: 0, present: 0, late: 0, halfDay: 0, absent: 0, excused: 0, percent: null };
  for (const d of days) {
    if (d.kind !== "working" || d.date > today || !enrolled(d.date)) continue;
    s.schoolDays += 1;
    const m = marks.get(d.date);
    if (!m) {
      s.unmarked += 1;
      continue;
    }
    s.marked += 1;
    if (m === "PRESENT") s.present += 1;
    else if (m === "LATE") s.late += 1;
    else if (m === "HALF_DAY") s.halfDay += 1;
    else if (m === "ABSENT") s.absent += 1;
    else s.excused += 1;
  }
  if (s.marked > 0) {
    const attended = new Decimal(s.present + s.late).plus(new Decimal(s.halfDay).times("0.5"));
    s.percent = attended.times(100).div(s.marked).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  }
  return s;
}

/**
 * AC7: who may change an already saved mark. The class teacher of the section (ASSIGNED marker) only on the same school
 * day; an academic.manage holder at any time with a reason. A new mark (no saved row) is a first mark, not a correction.
 */
export function correctionRule(input: {
  date: string;
  today: string;
  hasSavedMark: boolean;
  isClassTeacher: boolean;
  canManage: boolean;
}): { allowed: boolean; reasonRequired: boolean } {
  if (input.date > input.today) return { allowed: false, reasonRequired: false };
  if (!input.hasSavedMark) return { allowed: input.isClassTeacher || input.canManage, reasonRequired: false };
  if (input.isClassTeacher && input.date === input.today) return { allowed: true, reasonRequired: false };
  if (input.canManage) return { allowed: true, reasonRequired: true };
  return { allowed: false, reasonRequired: false };
}
