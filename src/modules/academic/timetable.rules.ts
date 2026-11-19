/**
 * Pure Phase 4A timetable rules (no I/O — unit tested). PHASE_4_PLAN.md AC5.
 *
 * - A period plan is per weekday: numbers 1–15 unique per day, times "HH:MM", each period ends after it starts and
 *   periods of one day don't overlap (touching is fine: 09:40–10:20 then 10:20–11:00).
 * - A timetable slot puts one class subject (and optionally its teacher) in one TEACHING period of one section. The
 *   database refuses a second slot for the same section × period and the same teacher × period; `findClashes` reports
 *   the same conflicts for a proposed set of slots BEFORE saving, so the screen can name them.
 */

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface PeriodInput {
  dayOfWeek: number;
  number: number;
  startTime: string;
  endTime: string;
  kind: "TEACHING" | "BREAK";
  label: string | null;
}

export type PeriodProblem =
  | { kind: "bad_day"; index: number }
  | { kind: "bad_number"; index: number }
  | { kind: "bad_time"; index: number }
  | { kind: "ends_before_start"; index: number }
  | { kind: "duplicate_number"; index: number; other: number }
  | { kind: "overlap"; index: number; other: number };

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Every problem in a period plan (empty = valid). Indexes refer to the input array. */
export function checkPeriodPlan(periods: readonly PeriodInput[]): PeriodProblem[] {
  const problems: PeriodProblem[] = [];
  periods.forEach((p, i) => {
    if (!Number.isInteger(p.dayOfWeek) || p.dayOfWeek < 0 || p.dayOfWeek > 6) problems.push({ kind: "bad_day", index: i });
    if (!Number.isInteger(p.number) || p.number < 1 || p.number > 15) problems.push({ kind: "bad_number", index: i });
    if (!TIME_RE.test(p.startTime) || !TIME_RE.test(p.endTime)) problems.push({ kind: "bad_time", index: i });
    else if (minutes(p.endTime) <= minutes(p.startTime)) problems.push({ kind: "ends_before_start", index: i });
  });
  if (problems.length > 0) return problems;
  for (let i = 0; i < periods.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = periods[i];
      const b = periods[j];
      if (a.dayOfWeek !== b.dayOfWeek) continue;
      if (a.number === b.number) problems.push({ kind: "duplicate_number", index: i, other: j });
      else if (minutes(a.startTime) < minutes(b.endTime) && minutes(b.startTime) < minutes(a.endTime)) {
        problems.push({ kind: "overlap", index: i, other: j });
      }
    }
  }
  return problems;
}

export interface SlotInput {
  sectionId: string;
  periodId: string;
  classSubjectId: string;
  employeeId: string | null;
}

export type SlotClash =
  | { kind: "section_busy"; sectionId: string; periodId: string }
  | { kind: "teacher_busy"; employeeId: string; periodId: string; sectionIds: [string, string] };

/**
 * Clashes in `proposed` against each other and against `existing` slots (other sections' saved slots). A proposed slot
 * replaces an existing slot of the SAME section and period (that is an edit, not a clash).
 */
export function findClashes(existing: readonly SlotInput[], proposed: readonly SlotInput[]): SlotClash[] {
  const key = (s: SlotInput) => `${s.sectionId}|${s.periodId}`;
  const replaced = new Set(proposed.map(key));
  const kept = existing.filter((s) => !replaced.has(key(s)));
  const clashes: SlotClash[] = [];

  const seen = new Set<string>();
  for (const s of proposed) {
    if (seen.has(key(s))) clashes.push({ kind: "section_busy", sectionId: s.sectionId, periodId: s.periodId });
    seen.add(key(s));
  }

  const teacherAt = new Map<string, string>(); // employee|period → section
  for (const s of [...kept, ...proposed]) {
    if (s.employeeId === null) continue;
    const k = `${s.employeeId}|${s.periodId}`;
    const other = teacherAt.get(k);
    if (other !== undefined && other !== s.sectionId) {
      clashes.push({ kind: "teacher_busy", employeeId: s.employeeId, periodId: s.periodId, sectionIds: [other, s.sectionId] });
    } else {
      teacherAt.set(k, s.sectionId);
    }
  }
  return clashes;
}
