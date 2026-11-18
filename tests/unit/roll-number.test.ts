import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import { assertCorrection, assertFinalizeConfirmation, compareForRoll, draftMatchesCurrent, nextAppendedNumber, orderForRollNumbers, rollNameKey, type RollCandidate } from "@/modules/students/roll-number";
import { correctRollSchema, finalizeRollSchema, generateRollSchema } from "@/modules/students/roll-numbers.schemas";

/** Phase 2B S6 — roll-number ordering and planning (D3, skill roll-number-generation). Synthetic names only. */
let n = 0;
const c = (fullName: string, dob = "2019-01-01", studentCode?: string): RollCandidate => ({ enrollmentId: `e${++n}`, fullName, dob: new Date(`${dob}T00:00:00Z`), studentCode: studentCode ?? `DEMO-2026-${String(n).padStart(4, "0")}` });
const names = (rows: RollCandidate[]) => orderForRollNumbers(rows).map((r) => `${r.rollNumber} ${r.fullName}`);

describe("ordering", () => {
  it("the skill's example: case-insensitive alphabetical order", () => {
    expect(names([c("Rohit Singh"), c("amit kumar"), c("Zoya Ahmed"), c("Ananya Das"), c("Rahul Sharma")])).toEqual([
      "1 amit kumar",
      "2 Ananya Das",
      "3 Rahul Sharma",
      "4 Rohit Singh",
      "5 Zoya Ahmed",
    ]);
  });
  it("accents, extra spaces and punctuation don't change the order", () => {
    expect(names([c("Zara Khan"), c("  Émile   Roy "), c("D'Souza Mary"), c("Emily Roy")]).map((s) => s.replace(/^\d+ /, "").trim())).toEqual(["D'Souza Mary", "Émile   Roy", "Emily Roy", "Zara Khan"]);
    expect(rollNameKey("  Ana \t  Das ")).toBe("Ana Das");
  });
  it("numbers inside names sort numerically ('Batch 2' before 'Batch 10')", () => {
    expect(names([c("Batch 10 Ravi"), c("Batch 2 Ravi")]).map((s) => s.slice(2))).toEqual(["Batch 2 Ravi", "Batch 10 Ravi"]);
  });
  it("identical names: older first, then the student ID — deterministic", () => {
    const younger = c("Aarav Patel", "2019-09-09", "DEMO-2026-0001");
    const older = c("Aarav Patel", "2019-01-01", "DEMO-2026-0009");
    const twinB = c("aarav patel", "2019-01-01", "DEMO-2026-0005");
    const ordered = orderForRollNumbers([younger, older, twinB]);
    expect(ordered.map((o) => o.studentCode)).toEqual(["DEMO-2026-0005", "DEMO-2026-0009", "DEMO-2026-0001"]);
    expect(compareForRoll(older, twinB)).toBeGreaterThan(0);
  });
  it("the result does not depend on the input order", () => {
    const rows = [c("Meera"), c("Arjun"), c("Kabir"), c("Diya"), c("Arjun", "2018-05-05")];
    const once = orderForRollNumbers(rows).map((r) => r.enrollmentId);
    for (const shuffled of [[...rows].reverse(), [rows[2], rows[0], rows[4], rows[1], rows[3]]]) {
      expect(orderForRollNumbers(shuffled).map((r) => r.enrollmentId)).toEqual(once);
    }
  });
  it("numbers are 1…n without gaps", () => {
    expect(orderForRollNumbers([c("B"), c("A"), c("C")]).map((r) => r.rollNumber)).toEqual([1, 2, 3]);
    expect(orderForRollNumbers([])).toEqual([]);
  });
});

describe("finalization safety", () => {
  const rows = [c("Ira"), c("Bela"), c("Om")];
  const draft = orderForRollNumbers(rows).map((r) => ({ enrollmentId: r.enrollmentId, rollNumber: r.rollNumber }));
  it("a draft matching a fresh generation may be finalized", () => {
    expect(draftMatchesCurrent(draft, rows)).toBe(true);
  });
  it("a student admitted or gone since → stale; a renamed student who now sorts differently → stale", () => {
    expect(draftMatchesCurrent(draft, [...rows, c("Aanya")])).toBe(false);
    expect(draftMatchesCurrent(draft, rows.slice(1))).toBe(false);
    expect(draftMatchesCurrent(draft, rows.map((r) => (r.fullName === "Om" ? { ...r, fullName: "Aaron" } : r)))).toBe(false);
  });
  it("type-to-confirm: the section code, case-insensitive", () => {
    expect(() => assertFinalizeConfirmation(" c06-a ", "C06-A")).not.toThrow();
    expect(() => assertFinalizeConfirmation("C06-B", "C06-A")).toThrow(ValidationError);
    expect(() => assertFinalizeConfirmation("", "C06-A")).toThrow(ValidationError);
  });
});

describe("late admissions and corrections (finalized numbers never change automatically)", () => {
  it("appends one past the highest number ever given — leavers' numbers are never reused", () => {
    expect(nextAppendedNumber([1, 2, 3])).toBe(4);
    expect(nextAppendedNumber([1, 2, 7])).toBe(8); // 7 was a correction; 3–6 stay unused
    expect(nextAppendedNumber([])).toBe(1);
  });
  const base = { batchStatus: "FINALIZED" as const, current: 4, target: 9, takenBy: null, enrollmentId: "e1" };
  it("a correction moves one student to a free number in a finalized batch", () => {
    expect(() => assertCorrection(base)).not.toThrow();
  });
  it.each([
    ["a draft batch", { batchStatus: "DRAFT" as const }, ConflictError],
    ["a number already used by another student", { takenBy: "e2" }, ConflictError],
    ["the same number", { target: 4 }, ValidationError],
    ["zero", { target: 0 }, ValidationError],
    ["over 999", { target: 1000 }, ValidationError],
    ["a fraction", { target: 2.5 }, ValidationError],
  ])("refuses %s", (_l, over, err) => {
    expect(() => assertCorrection({ ...base, ...over })).toThrow(err);
  });
});

describe("roll-number action schemas", () => {
  it("generate: version optional (first generation) or a positive integer", () => {
    expect(generateRollSchema.parse({ sectionId: "s", version: "" })).toEqual({ sectionId: "s", version: null });
    expect(generateRollSchema.parse({ sectionId: "s", version: "3" })).toEqual({ sectionId: "s", version: 3 });
    expect(generateRollSchema.safeParse({ sectionId: "s", version: "x" }).success).toBe(false);
  });
  it("finalize needs the confirmation text and a version", () => {
    expect(finalizeRollSchema.safeParse({ sectionId: "s", version: "2", confirm: "" }).success).toBe(false);
    expect(finalizeRollSchema.parse({ sectionId: "s", version: "2", confirm: " C06-A " }).confirm).toBe("C06-A");
  });
  it("correct needs a whole number 1–999 and a reason", () => {
    const ok = { sectionId: "s", enrollmentId: "e", version: "1", rollNumber: "12", reason: " Wrong   spelling earlier " };
    expect(correctRollSchema.parse(ok)).toMatchObject({ rollNumber: 12, reason: "Wrong spelling earlier" });
    for (const over of [{ rollNumber: "0" }, { rollNumber: "1000" }, { rollNumber: "1.5" }, { reason: "no" }, { extra: 1 }]) {
      expect(correctRollSchema.safeParse({ ...ok, ...over }).success, JSON.stringify(over)).toBe(false);
    }
  });
});
