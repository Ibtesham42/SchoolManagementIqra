import Decimal from "decimal.js";
import { calculateResult, GradeCalcError, type GradeBand, type OverallResult, type SubjectResult } from "./grade-calc";
import { entryProblem, type MarkEntry, type Maxima } from "./marks.rules";

/**
 * Phase 4B-M6 — results and report-card snapshots (pure; PHASE_4_PLAN.md AC9, AC14, AC15, AC21).
 * - A student's result covers the exam subjects of their class that they take (compulsory + chosen optional ones).
 * - Missing or incomplete marks → no result (the preview shows "incomplete"; publication refuses earlier, at lock).
 * - Attendance % (AC21) = (present + late + ½ half day) / marked days, up to the exam's end date; EXCUSED counts as not
 *   attended. Rounded half-up to 2 dp, like the attendance register.
 * - The snapshot (version 1) is what the report card prints forever after; later scale or marks edits never change it.
 */
export interface ExamSubjectInfo {
  id: string;
  code: string;
  name: string;
  max: Maxima;
  passPercent: string | null;
}

export function studentResult(scale: readonly GradeBand[], subjects: readonly ExamSubjectInfo[], marks: ReadonlyMap<string, MarkEntry>): OverallResult | null {
  if (subjects.length === 0) return null;
  const input = [];
  for (const s of subjects) {
    const m = marks.get(s.id);
    if (!m || entryProblem(m, s.max, false) !== null) return null;
    input.push({
      code: s.code,
      name: s.name,
      scholastic: true,
      status: m.status,
      passPercent: s.passPercent,
      parts: [
        { max: s.max.theory, obtained: m.theory },
        { max: s.max.practical, obtained: m.practical },
        { max: s.max.internal, obtained: m.internal },
      ],
    });
  }
  try {
    return calculateResult(scale, input);
  } catch (e) {
    if (e instanceof GradeCalcError) return null;
    throw e;
  }
}

export interface AttendanceCounts {
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  excused: number;
}

export function attendancePercent(c: AttendanceCounts): { marked: number; percent: string | null } {
  const marked = c.present + c.late + c.halfDay + c.absent + c.excused;
  if (marked === 0) return { marked, percent: null };
  const attended = new Decimal(c.present + c.late).plus(new Decimal(c.halfDay).times("0.5"));
  return { marked, percent: attended.times(100).div(marked).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2) };
}

export interface ReportCardSnapshot {
  v: 1;
  exam: { name: string; session: string; startDate: string | null; endDate: string | null };
  student: { code: string; name: string; rollNumber: number | null; className: string; sectionCode: string };
  scale: string;
  subjects: (SubjectResult & { maxParts: Maxima; parts: { theory: string | null; practical: string | null; internal: string | null } })[];
  total: { obtained: string; max: number; percent: string | null; grade: string | null; result: "PASS" | "FAIL" | "NO_RESULT" };
  rank: number | null;
  attendance: { marked: number; percent: string | null };
}

export function buildSnapshot(args: {
  exam: ReportCardSnapshot["exam"];
  student: ReportCardSnapshot["student"];
  scale: string;
  subjects: readonly ExamSubjectInfo[];
  marks: ReadonlyMap<string, MarkEntry>;
  result: OverallResult;
  rank: number | null;
  attendance: ReportCardSnapshot["attendance"];
}): ReportCardSnapshot {
  return {
    v: 1,
    exam: args.exam,
    student: args.student,
    scale: args.scale,
    subjects: args.result.subjects.map((r, i) => {
      const s = args.subjects[i];
      const m = args.marks.get(s.id)!;
      return { ...r, maxParts: s.max, parts: { theory: m.theory, practical: m.practical, internal: m.internal } };
    }),
    total: { obtained: args.result.obtained, max: args.result.max, percent: args.result.percent, grade: args.result.grade, result: args.result.result },
    rank: args.rank,
    attendance: args.attendance,
  };
}

/** Defensive read of a stored snapshot (JSON from the database) for display and PDF rendering. */
export function readSnapshot(v: unknown): ReportCardSnapshot | null {
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<ReportCardSnapshot>;
  if (s.v !== 1 || !s.exam || !s.student || !Array.isArray(s.subjects) || !s.total || !s.attendance) return null;
  return s as ReportCardSnapshot;
}

export const RESULT_LABEL: Record<ReportCardSnapshot["total"]["result"], string> = { PASS: "Pass", FAIL: "Not passed", NO_RESULT: "No result" };
