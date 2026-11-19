import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  calculateResult,
  CBSE_STYLE_8_POINT,
  GradeCalcError,
  gradeFor,
  rankByPercent,
  validateScale,
  type GradeBand,
  type SubjectMarks,
} from "@/modules/academic/grade-calc";

/** Phase 4B pure grading — boundaries, AB vs EX, pass/fail, rounding, ranking (PHASE_4_PLAN.md AC8, AC10, AC14). */
const scale = validateScale(CBSE_STYLE_8_POINT);
const subj = (code: string, theory: string | null, over: Partial<SubjectMarks> = {}): SubjectMarks => ({
  code,
  name: code,
  scholastic: true,
  status: "PRESENT",
  parts: [
    { max: 80, obtained: theory },
    { max: 20, obtained: "20" },
  ],
  passPercent: "33",
  ...over,
});
const err = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof GradeCalcError ? e.code : "other";
  }
  return null;
};

describe("scales", () => {
  it("CBSE-style template validates and grades every boundary", () => {
    const at = (p: string) => gradeFor(scale, new Decimal(p)).grade;
    expect([at("0"), at("32.99"), at("33"), at("40.99"), at("41"), at("50"), at("51"), at("61"), at("71"), at("81"), at("90.99"), at("91"), at("100")]).toEqual(
      ["E", "E", "D", "D", "C2", "C2", "C1", "B2", "B1", "A2", "A2", "A1", "A1"],
    );
  });
  it("the grade uses the UNROUNDED percentage (90.995 % shows as 91.00 % but is A2)", () => {
    expect(gradeFor(scale, new Decimal("90.995")).grade).toBe("A2");
  });
  it("refuses gaps at 0, duplicate minimums, duplicate grades, out-of-range values, too few bands", () => {
    const b = (minPercent: string, grade: string): GradeBand => ({ minPercent, grade, gradePoint: null, remark: null });
    expect(err(() => validateScale([b("10", "B"), b("50", "A")]))).toBe("BAD_SCALE");
    expect(err(() => validateScale([b("0", "B"), b("50", "A"), b("50", "A+")]))).toBe("BAD_SCALE");
    expect(err(() => validateScale([b("0", "A"), b("50", "A")]))).toBe("BAD_SCALE");
    expect(err(() => validateScale([b("0", "B"), b("101", "A")]))).toBe("BAD_SCALE");
    expect(err(() => validateScale([b("0", "A")]))).toBe("BAD_SCALE");
    expect(validateScale([b("50", "A"), b("0", "B")]).map((x) => x.grade)).toEqual(["B", "A"]); // sorted
  });
});

describe("calculateResult", () => {
  it("totals parts, rounds the shown percentage half-up, grades subjects and overall", () => {
    const r = calculateResult(scale, [subj("ENG", "70.5"), subj("MAT", "51")]);
    expect(r.subjects.map((s) => [s.code, s.obtained, s.max, s.percent, s.grade, s.passed])).toEqual([
      ["ENG", "90.5", 100, "90.50", "A2", true],
      ["MAT", "71", 100, "71.00", "B1", true],
    ]);
    expect([r.obtained, r.max, r.percent, r.grade, r.result]).toEqual(["161.5", 200, "80.75", "B1", "PASS"]);
  });

  it("AB counts 0 of the full maximum (and fails); EX leaves the subject out of the totals", () => {
    const r = calculateResult(scale, [subj("ENG", "60"), subj("MAT", null, { status: "ABSENT" }), subj("ART", null, { status: "EXEMPT" })]);
    expect(r.subjects.find((s) => s.code === "MAT")).toMatchObject({ obtained: "0", max: 100, percent: "0.00", grade: "E", passed: false });
    expect(r.subjects.find((s) => s.code === "ART")).toMatchObject({ max: 0, percent: null, grade: null, passed: null });
    expect([r.obtained, r.max, r.percent, r.result, r.failedSubjects]).toEqual(["80", 200, "40.00", "FAIL", ["MAT"]]);
  });

  it("pass mark boundary is inclusive; subjects without a pass mark never fail", () => {
    const at33 = calculateResult(scale, [subj("ENG", "13", { parts: [{ max: 100, obtained: "33" }] })]);
    expect(at33.result).toBe("PASS");
    const below = calculateResult(scale, [subj("ENG", null, { parts: [{ max: 100, obtained: "32.5" }] })]);
    expect(below.result).toBe("FAIL");
    const noPass = calculateResult(scale, [subj("ENG", null, { parts: [{ max: 100, obtained: "5" }], passPercent: null })]);
    expect([noPass.result, noPass.subjects[0].passed]).toEqual(["PASS", null]);
  });

  it("co-scholastic subjects get a grade but don't count in totals or fail the result", () => {
    const r = calculateResult(scale, [subj("ENG", "60"), subj("PE", null, { scholastic: false, parts: [{ max: 50, obtained: "5" }] })]);
    expect([r.obtained, r.max, r.result]).toEqual(["80", 100, "PASS"]);
    expect(r.subjects[1]).toMatchObject({ grade: "E", passed: false });
  });

  it("all exempt → no result", () => {
    expect(calculateResult(scale, [subj("ART", null, { status: "EXEMPT" })]).result).toBe("NO_RESULT");
  });

  it("refuses marks above the maximum, missing marks, quarter marks, bad maximums and bad pass marks", () => {
    expect(err(() => calculateResult(scale, [subj("ENG", "81")]))).toBe("BAD_MARKS");
    expect(err(() => calculateResult(scale, [subj("ENG", null)]))).toBe("BAD_MARKS");
    expect(err(() => calculateResult(scale, [subj("ENG", "70.25")]))).toBe("BAD_MARKS");
    expect(err(() => calculateResult(scale, [subj("ENG", "70", { parts: [{ max: 0, obtained: null }] })]))).toBe("BAD_MARKS");
    expect(err(() => calculateResult(scale, [subj("ENG", "70", { parts: [{ max: 1.5, obtained: "1" }] })]))).toBe("BAD_MARKS");
    expect(err(() => calculateResult(scale, [subj("ENG", "70", { passPercent: "abc" })]))).toBe("BAD_MARKS");
  });

  it("a part with maximum 0 is not examined and needs no marks", () => {
    const r = calculateResult(scale, [subj("ENG", "40", { parts: [{ max: 80, obtained: "40" }, { max: 0, obtained: null }] })]);
    expect(r.percent).toBe("50.00");
  });
});

describe("rankByPercent (AC14)", () => {
  it("ties share a rank; the next rank skips (1, 1, 3); no result → no rank", () => {
    const rows = [
      { id: "a", percentExact: new Decimal("80.5") },
      { id: "b", percentExact: new Decimal("92") },
      { id: "c", percentExact: new Decimal("80.5") },
      { id: "d", percentExact: null },
      { id: "e", percentExact: new Decimal("70") },
    ];
    expect(Object.fromEntries(rankByPercent(rows))).toEqual({ b: 1, a: 2, c: 2, e: 4 });
  });
  it("ranks on the unrounded value: 80.004 and 80.001 both show 80.00 % but rank 1 and 2", () => {
    const r = rankByPercent([
      { id: "x", percentExact: new Decimal("80.001") },
      { id: "y", percentExact: new Decimal("80.004") },
    ]);
    expect([r.get("y"), r.get("x")]).toEqual([1, 2]);
  });
});
