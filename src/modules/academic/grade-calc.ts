import Decimal from "decimal.js";

/**
 * Pure Phase 4B grading (no I/O — unit tested). PHASE_4_PLAN.md AC8, AC10, AC14; academic-examination skill.
 *
 * - A scale is a list of bands by MINIMUM percent, strictly increasing from 0: contiguous and gap-free by construction
 *   (a band runs from its minimum up to the next band's minimum). The grade is looked up on the UNROUNDED percentage
 *   (90.5 % is below a 91 % band); the percentage shown is rounded half-up to 2 dp.
 * - Marks are whole or half marks per part (theory / practical / internal), each ≤ its maximum.
 * - AB (absent) counts 0 out of the full maximum; EX (exempt) leaves the subject out of the totals entirely (AC10).
 * - Only scholastic subjects count towards totals. A subject fails when it has a pass percent and is below it (AB
 *   included); the result is PASS when no subject fails.
 * - Rank (AC14, optional): standard competition ranking on the unrounded percentage — ties share a rank (1, 1, 3).
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
type Dec = InstanceType<typeof D>;

export interface GradeBand {
  /** Inclusive minimum percent, "0"–"100", at most 2 dp. */
  minPercent: string;
  grade: string;
  gradePoint: string | null;
  remark: string | null;
}

export class GradeCalcError extends Error {
  constructor(
    readonly code: "BAD_SCALE" | "BAD_MARKS",
    message: string,
  ) {
    super(message);
    this.name = "GradeCalcError";
  }
}

const PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;
const MARK_RE = /^\d{1,4}(\.5|\.0)?$/;

/** Validate a scale: first band at 0, strictly increasing minimums ≤ 100, unique non-empty grades. Returns it sorted. */
export function validateScale(bands: readonly GradeBand[]): GradeBand[] {
  if (bands.length < 2 || bands.length > 20) throw new GradeCalcError("BAD_SCALE", "A grading scale needs 2 to 20 bands.");
  const sorted = [...bands].sort((a, b) => new D(a.minPercent).cmp(b.minPercent));
  const grades = new Set<string>();
  sorted.forEach((b, i) => {
    if (!PERCENT_RE.test(b.minPercent) || new D(b.minPercent).gt(100)) {
      throw new GradeCalcError("BAD_SCALE", `"${b.grade}": the minimum must be a percentage from 0 to 100.`);
    }
    if (i === 0 && !new D(b.minPercent).eq(0)) throw new GradeCalcError("BAD_SCALE", "The lowest band must start at 0 %.");
    if (i > 0 && new D(b.minPercent).eq(sorted[i - 1].minPercent)) {
      throw new GradeCalcError("BAD_SCALE", `Two bands start at ${b.minPercent} %.`);
    }
    const g = b.grade.trim();
    if (g === "" || g.length > 5) throw new GradeCalcError("BAD_SCALE", "Each band needs a grade of 1–5 characters.");
    if (grades.has(g)) throw new GradeCalcError("BAD_SCALE", `Grade "${g}" appears twice.`);
    grades.add(g);
  });
  return sorted;
}

/** The band for an (unrounded) percentage. The scale must have been validated. */
export function gradeFor(scale: readonly GradeBand[], percent: Dec): GradeBand {
  let found = scale[0];
  for (const b of scale) if (percent.gte(b.minPercent)) found = b;
  return found;
}

/**
 * AC8 template, offered for the school to review and save — never created automatically. Mirrors the widely published
 * CBSE 8-point scale (A1 91–100 … E up to 32); the school must confirm it matches its own rules.
 */
export const CBSE_STYLE_8_POINT: readonly GradeBand[] = [
  { minPercent: "0", grade: "E", gradePoint: null, remark: "Needs improvement" },
  { minPercent: "33", grade: "D", gradePoint: "4", remark: null },
  { minPercent: "41", grade: "C2", gradePoint: "5", remark: null },
  { minPercent: "51", grade: "C1", gradePoint: "6", remark: null },
  { minPercent: "61", grade: "B2", gradePoint: "7", remark: null },
  { minPercent: "71", grade: "B1", gradePoint: "8", remark: null },
  { minPercent: "81", grade: "A2", gradePoint: "9", remark: null },
  { minPercent: "91", grade: "A1", gradePoint: "10", remark: null },
];

// ───────────────────────────── Marks → subject and overall results ─────────────────────────────

export interface MarkPart {
  /** Maximum for this part (whole marks); 0 = the part isn't examined. */
  max: number;
  /** Obtained ("12" or "12.5"); null when not entered. */
  obtained: string | null;
}

export interface SubjectMarks {
  code: string;
  name: string;
  scholastic: boolean;
  status: "PRESENT" | "ABSENT" | "EXEMPT";
  parts: readonly MarkPart[];
  /** Pass threshold in percent (e.g. "33"); null = no pass mark for this subject. */
  passPercent: string | null;
}

export interface SubjectResult {
  code: string;
  name: string;
  status: "PRESENT" | "ABSENT" | "EXEMPT";
  obtained: string;
  max: number;
  /** Rounded half-up to 2 dp; null when exempt. */
  percent: string | null;
  grade: string | null;
  passed: boolean | null;
}

export interface OverallResult {
  subjects: SubjectResult[];
  obtained: string;
  max: number;
  percent: string | null;
  /** Unrounded, for ranking. */
  percentExact: Dec | null;
  grade: string | null;
  result: "PASS" | "FAIL" | "NO_RESULT";
  failedSubjects: string[];
}

function subjectTotal(s: SubjectMarks): { obtained: Dec; max: number } {
  let obtained = new D(0);
  let max = 0;
  for (const p of s.parts) {
    if (!Number.isInteger(p.max) || p.max < 0 || p.max > 1000) throw new GradeCalcError("BAD_MARKS", `${s.name}: a maximum must be a whole number up to 1000.`);
    max += p.max;
    if (s.status !== "PRESENT" || p.max === 0) continue;
    if (p.obtained === null) throw new GradeCalcError("BAD_MARKS", `${s.name}: marks are missing.`);
    if (!MARK_RE.test(p.obtained)) throw new GradeCalcError("BAD_MARKS", `${s.name}: use whole or half marks.`);
    const o = new D(p.obtained);
    if (o.gt(p.max)) throw new GradeCalcError("BAD_MARKS", `${s.name}: ${p.obtained} is more than the maximum ${p.max}.`);
    obtained = obtained.plus(o);
  }
  if (max === 0) throw new GradeCalcError("BAD_MARKS", `${s.name}: no part of this subject has a maximum.`);
  return { obtained, max };
}

const pct = (obtained: Dec, max: number) => obtained.times(100).div(max);

export function calculateResult(scale: readonly GradeBand[], subjects: readonly SubjectMarks[]): OverallResult {
  const out: SubjectResult[] = [];
  let obtained = new D(0);
  let max = 0;
  const failed: string[] = [];
  for (const s of subjects) {
    if (s.passPercent !== null && (!PERCENT_RE.test(s.passPercent) || new D(s.passPercent).gt(100))) {
      throw new GradeCalcError("BAD_MARKS", `${s.name}: the pass mark must be a percentage.`);
    }
    if (s.status === "EXEMPT") {
      out.push({ code: s.code, name: s.name, status: s.status, obtained: "0", max: 0, percent: null, grade: null, passed: null });
      continue;
    }
    const t = subjectTotal(s);
    const p = pct(t.obtained, t.max);
    const passed = s.passPercent === null ? null : p.gte(s.passPercent);
    if (passed === false && s.scholastic) failed.push(s.code);
    out.push({
      code: s.code,
      name: s.name,
      status: s.status,
      obtained: t.obtained.toString(),
      max: t.max,
      percent: p.toFixed(2),
      grade: gradeFor(scale, p).grade,
      passed,
    });
    if (s.scholastic) {
      obtained = obtained.plus(t.obtained);
      max += t.max;
    }
  }
  if (max === 0) {
    return { subjects: out, obtained: "0", max: 0, percent: null, percentExact: null, grade: null, result: "NO_RESULT", failedSubjects: failed };
  }
  const exact = pct(obtained, max);
  return {
    subjects: out,
    obtained: obtained.toString(),
    max,
    percent: exact.toFixed(2),
    percentExact: exact,
    grade: gradeFor(scale, exact).grade,
    result: failed.length > 0 ? "FAIL" : "PASS",
    failedSubjects: failed,
  };
}

/** AC14: standard competition ranking (1, 1, 3) on the unrounded percentage; students without a result get no rank. */
export function rankByPercent<T extends { id: string; percentExact: Dec | null }>(rows: readonly T[]): Map<string, number> {
  const ranked = rows.filter((r) => r.percentExact !== null).sort((a, b) => b.percentExact!.cmp(a.percentExact!));
  const ranks = new Map<string, number>();
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    ranks.set(r.id, prev && prev.percentExact!.eq(r.percentExact!) ? ranks.get(prev.id)! : i + 1);
  });
  return ranks;
}
