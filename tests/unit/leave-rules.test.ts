import { describe, expect, it } from "vitest";
import {
  available,
  classifyRange,
  isWeeklyOff,
  leaveDays,
  NO_WEEKLY_OFF,
  parseDays,
  readWeeklyOff,
  weeklyOffSchema,
} from "@/modules/hr/leave.rules";
import {
  createHolidaySchema,
  createLeaveTypeSchema,
  openingBalanceSchema,
  weeklyOffFormSchema,
} from "@/modules/hr/leave.schemas";

const SUN_2_4_SAT = { days: [0], saturdays: [2, 4] };
const none = new Set<string>();

describe("weekly off (L3)", () => {
  it("Sundays and the 2nd/4th Saturdays", () => {
    // November 2026: Sat 7, 14, 21, 28; Sun 1, 8, …
    expect(isWeeklyOff("2026-11-01", SUN_2_4_SAT)).toBe(true);
    expect(isWeeklyOff("2026-11-07", SUN_2_4_SAT)).toBe(false); // 1st Saturday
    expect(isWeeklyOff("2026-11-14", SUN_2_4_SAT)).toBe(true); // 2nd
    expect(isWeeklyOff("2026-11-21", SUN_2_4_SAT)).toBe(false); // 3rd
    expect(isWeeklyOff("2026-11-28", SUN_2_4_SAT)).toBe(true); // 4th
    expect(isWeeklyOff("2026-11-02", SUN_2_4_SAT)).toBe(false); // Monday
  });
  it("5th Saturday is recognised", () => {
    expect(isWeeklyOff("2026-08-29", { days: [], saturdays: [5] })).toBe(true); // Aug 2026: 1, 8, 15, 22, 29
  });
  it("no setting → nothing is off (no invented default)", () => {
    expect(readWeeklyOff(null)).toEqual(NO_WEEKLY_OFF);
    expect(readWeeklyOff({ days: "x" })).toEqual(NO_WEEKLY_OFF);
    expect(isWeeklyOff("2026-11-01", NO_WEEKLY_OFF)).toBe(false);
  });
  it("schema refuses every-day-off, duplicates, extra keys and Saturday conflicts", () => {
    expect(
      weeklyOffSchema.safeParse({ days: [0, 1, 2, 3, 4, 5, 6], saturdays: [] })
        .success,
    ).toBe(false);
    expect(
      weeklyOffSchema.safeParse({ days: [0, 0], saturdays: [] }).success,
    ).toBe(false);
    expect(
      weeklyOffSchema.safeParse({ days: [6], saturdays: [2] }).success,
    ).toBe(false);
    expect(
      weeklyOffSchema.safeParse({ days: [0], saturdays: [], x: 1 }).success,
    ).toBe(false);
    expect(
      weeklyOffSchema.safeParse({ days: [7], saturdays: [] }).success,
    ).toBe(false);
    expect(weeklyOffSchema.safeParse(SUN_2_4_SAT).success).toBe(true);
  });
  it("form schema coerces checkbox values", () => {
    expect(
      weeklyOffFormSchema.parse({ days: ["0"], saturdays: ["2", "4"] }),
    ).toEqual(SUN_2_4_SAT);
  });
});

describe("working days and leave days (L1, L10)", () => {
  it("classifies a week with a holiday", () => {
    const kinds = classifyRange(
      "2026-11-08",
      "2026-11-14",
      SUN_2_4_SAT,
      new Set(["2026-11-10"]),
    ).map((d) => d.kind);
    expect(kinds).toEqual([
      "weekly_off",
      "working",
      "holiday",
      "working",
      "working",
      "working",
      "weekly_off",
    ]);
  });
  it("counts only working days", () => {
    expect(
      leaveDays(
        { from: "2026-11-08", to: "2026-11-14", halfDay: false },
        SUN_2_4_SAT,
        new Set(["2026-11-10"]),
      ).toString(),
    ).toBe("4");
  });
  it("half day = 0.5 only for a single working date", () => {
    expect(
      leaveDays(
        { from: "2026-11-09", to: "2026-11-09", halfDay: true },
        SUN_2_4_SAT,
        none,
      ).toString(),
    ).toBe("0.5");
    expect(
      leaveDays(
        { from: "2026-11-08", to: "2026-11-08", halfDay: true },
        SUN_2_4_SAT,
        none,
      ).toString(),
    ).toBe("0");
    expect(
      leaveDays(
        { from: "2026-11-09", to: "2026-11-10", halfDay: true },
        SUN_2_4_SAT,
        none,
      ).toString(),
    ).toBe("0");
  });
  it("crosses month boundaries and refuses ranges over a year", () => {
    expect(
      classifyRange("2026-11-30", "2026-12-01", NO_WEEKLY_OFF, none),
    ).toHaveLength(2);
    expect(() =>
      classifyRange("2026-01-01", "2027-06-01", NO_WEEKLY_OFF, none),
    ).toThrow();
  });
});

describe("days and balances", () => {
  it("parses whole and half days only", () => {
    expect(parseDays("12")?.toString()).toBe("12");
    expect(parseDays("7.5")?.toString()).toBe("7.5");
    for (const bad of ["7.25", "-1", "367", "1e2", "", "abc", "0.3"])
      expect(parseDays(bad)).toBeNull();
  });
  it("available = allotted + carried forward − used, exactly", () => {
    expect(
      available({
        allotted: "12",
        carriedForward: "2.5",
        used: "0.5",
      }).toString(),
    ).toBe("14");
  });
});

describe("leave schemas", () => {
  const base = {
    code: "CL",
    name: "Casual leave",
    isPaid: "on",
    annualQuota: "12",
    allowHalfDay: "on",
    carryForwardMax: "0",
    appliesTo: "ALL",
  };
  it("accepts a valid type and normalises days", () => {
    const r = createLeaveTypeSchema.parse(base);
    expect(r).toMatchObject({
      isPaid: true,
      allowHalfDay: true,
      annualQuota: "12",
      carryForwardMax: "0",
    });
  });
  it("empty quota → null; unpaid can't carry forward; unknown keys refused", () => {
    expect(
      createLeaveTypeSchema.parse({ ...base, annualQuota: "" }).annualQuota,
    ).toBeNull();
    expect(
      createLeaveTypeSchema.safeParse({
        ...base,
        isPaid: "",
        carryForwardMax: "5",
      }).success,
    ).toBe(false);
    expect(
      createLeaveTypeSchema.safeParse({ ...base, extra: "x" }).success,
    ).toBe(false);
    expect(
      createLeaveTypeSchema.safeParse({ ...base, appliesTo: "ANYONE" }).success,
    ).toBe(false);
  });
  it("holiday and opening balance", () => {
    expect(
      createHolidaySchema.safeParse({
        date: "2026-08-15",
        name: "  Independence   Day ",
        appliesTo: "ALL",
      }),
    ).toMatchObject({ success: true, data: { name: "Independence Day" } });
    expect(
      createHolidaySchema.safeParse({
        date: "2026-02-30",
        name: "X day",
        appliesTo: "ALL",
      }).success,
    ).toBe(false);
    expect(
      openingBalanceSchema.safeParse({
        employeeId: "e1",
        leaveTypeId: "t1",
        academicSessionId: "s1",
        version: null,
        allotted: "12",
        carriedForward: "1.5",
      }).success,
    ).toBe(true);
    expect(
      openingBalanceSchema.safeParse({
        employeeId: "e1",
        leaveTypeId: "t1",
        academicSessionId: "s1",
        version: null,
        allotted: "12.25",
        carriedForward: "0",
      }).success,
    ).toBe(false);
  });
});
