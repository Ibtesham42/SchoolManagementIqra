import { describe, expect, it } from "vitest";
import { checkPeriodPlan, findClashes, type PeriodInput, type SlotInput } from "@/modules/academic/timetable.rules";

/** Phase 4A pure timetable rules (PHASE_4_PLAN.md AC5). */
const p = (dayOfWeek: number, number: number, startTime: string, endTime: string, kind: "TEACHING" | "BREAK" = "TEACHING"): PeriodInput => ({
  dayOfWeek,
  number,
  startTime,
  endTime,
  kind,
  label: null,
});
const slot = (sectionId: string, periodId: string, employeeId: string | null, classSubjectId = "cs"): SlotInput => ({ sectionId, periodId, classSubjectId, employeeId });

describe("checkPeriodPlan", () => {
  it("accepts touching periods and the same numbers on different days", () => {
    expect(checkPeriodPlan([p(1, 1, "08:00", "08:40"), p(1, 2, "08:40", "09:20"), p(1, 3, "09:20", "09:35", "BREAK"), p(2, 1, "08:00", "08:40")])).toEqual([]);
  });
  it("reports overlaps and duplicate numbers within a day", () => {
    expect(checkPeriodPlan([p(1, 1, "08:00", "08:45"), p(1, 2, "08:40", "09:20"), p(1, 2, "10:00", "10:40")])).toEqual([
      { kind: "overlap", index: 1, other: 0 },
      { kind: "duplicate_number", index: 2, other: 1 },
    ]);
  });
  it("reports bad days, numbers, times and periods that end before they start", () => {
    expect(checkPeriodPlan([p(7, 1, "08:00", "08:40"), p(1, 16, "08:00", "08:40"), p(1, 2, "8:00", "08:40"), p(1, 3, "09:00", "09:00")]).map((x) => x.kind)).toEqual([
      "bad_day",
      "bad_number",
      "bad_time",
      "ends_before_start",
    ]);
  });
});

describe("findClashes", () => {
  it("a teacher can't be in two sections in the same period (against saved slots and within the proposal)", () => {
    expect(findClashes([slot("6A", "mon1", "t1")], [slot("6B", "mon1", "t1")])).toEqual([
      { kind: "teacher_busy", employeeId: "t1", periodId: "mon1", sectionIds: ["6A", "6B"] },
    ]);
    expect(findClashes([], [slot("6A", "mon2", "t2"), slot("6B", "mon2", "t2")])).toHaveLength(1);
  });
  it("editing a section's own slot is not a clash; different periods are fine; slots without a teacher never clash on teachers", () => {
    expect(findClashes([slot("6A", "mon1", "t1")], [slot("6A", "mon1", "t1", "cs2")])).toEqual([]);
    expect(findClashes([slot("6A", "mon1", "t1")], [slot("6B", "mon2", "t1")])).toEqual([]);
    expect(findClashes([slot("6A", "mon1", null)], [slot("6B", "mon1", null)])).toEqual([]);
  });
  it("moving a teacher away frees the period: replacing 6A's slot with another teacher lets 6B use the first teacher", () => {
    expect(findClashes([slot("6A", "mon1", "t1")], [slot("6A", "mon1", "t9"), slot("6B", "mon1", "t1")])).toEqual([]);
  });
  it("two subjects in one section period in the same proposal", () => {
    expect(findClashes([], [slot("6A", "mon1", null, "x"), slot("6A", "mon1", null, "y")])).toEqual([{ kind: "section_busy", sectionId: "6A", periodId: "mon1" }]);
  });
});
