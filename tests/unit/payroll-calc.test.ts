import { describe, expect, it } from "vitest";
import { classifyRange } from "@/modules/hr/leave.rules";
import { calculateSlip, PayrollCalcError, slipDays, type SalaryItem, type SlipInput } from "@/modules/payroll/payroll-calc";

/** Phase 3C pure payroll calculator — golden values worked by hand (PHASE_3C_PLAN.md §2; payroll-management skill). */
const ITEMS: SalaryItem[] = [
  { code: "DA", name: "Dearness allowance", kind: "EARNING", calc: "PERCENT_OF_BASIC", value: "10", prorated: true },
  { code: "HRA", name: "House rent allowance", kind: "EARNING", calc: "FIXED", value: "5000", prorated: true },
  { code: "TA", name: "Transport allowance", kind: "EARNING", calc: "FIXED", value: "1600", prorated: false },
  { code: "PF", name: "Provident fund", kind: "DEDUCTION", calc: "PERCENT_OF_BASIC", value: "12", prorated: true },
  { code: "PT", name: "Professional tax", kind: "DEDUCTION", calc: "FIXED", value: "200", prorated: false },
];
const base = (over: Partial<SlipInput> = {}): SlipInput => ({
  basic: "30000",
  items: ITEMS,
  monthDays: 26,
  offRollsDays: 0,
  lopDays: "0",
  adjustments: [],
  ...over,
});
const amounts = (lines: { code: string; amount: string }[]) => Object.fromEntries(lines.map((l) => [l.code, l.amount]));
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof PayrollCalcError ? e.code : "other";
  }
  return null;
};

describe("calculateSlip", () => {
  it("full month: every component at its full value", () => {
    const s = calculateSlip(base());
    expect(amounts(s.earnings)).toEqual({ BASIC: "30000.00", DA: "3000.00", HRA: "5000.00", TA: "1600.00" });
    expect(amounts(s.deductions)).toEqual({ PF: "3600.00", PT: "200.00" });
    expect([s.gross, s.totalDeductions, s.net, s.paidDays]).toEqual(["39600.00", "3800.00", "35800.00", "26"]);
  });

  it("2.5 LOP days of 26: prorated items × 23.5/26, each rounded half-up to 2 dp; unprorated items unchanged", () => {
    const s = calculateSlip(base({ lopDays: "2.5" }));
    // 30000 × 23.5/26 = 27115.3846… ; 3000 × … = 2711.5384… ; 5000 × … = 4519.2307… ; 3600 × … = 3253.8461…
    expect(amounts(s.earnings)).toEqual({ BASIC: "27115.38", DA: "2711.54", HRA: "4519.23", TA: "1600.00" });
    expect(amounts(s.deductions)).toEqual({ PF: "3253.85", PT: "200.00" });
    expect([s.gross, s.totalDeductions, s.net, s.paidDays, s.lopDays]).toEqual(["35946.15", "3453.85", "32492.30", "23.5", "2.5"]);
  });

  it("rounds half-UP (not banker's): 0.05 × ½ = 0.025 → 0.03", () => {
    expect(calculateSlip({ basic: "0.05", items: [], monthDays: 2, offRollsDays: 1, lopDays: "0", adjustments: [] }).net).toBe("0.03");
  });

  it("mid-month joiner is prorated on the MONTH's days (24 working days, 11 before joining)", () => {
    const s = calculateSlip(base({ monthDays: 24, offRollsDays: 11, items: [] }));
    expect(s.paidDays).toBe("13");
    expect(s.net).toBe("16250.00"); // 30000 × 13/24
  });

  it("adjustments: bonus / arrears add to gross, other deductions to deductions", () => {
    const s = calculateSlip(
      base({
        adjustments: [
          { kind: "BONUS", amount: "1000" },
          { kind: "ARREARS", amount: "250.50" },
          { kind: "OTHER_DEDUCTION", amount: "500" },
        ],
      }),
    );
    expect([s.gross, s.totalDeductions, s.net]).toEqual(["40850.50", "4300.00", "36550.50"]);
  });

  it("whole month LOP: prorated pay is zero, unprorated items still apply", () => {
    const s = calculateSlip(base({ lopDays: "26" }));
    expect(amounts(s.earnings)).toEqual({ BASIC: "0.00", DA: "0.00", HRA: "0.00", TA: "1600.00" });
    expect([s.gross, s.totalDeductions, s.net]).toEqual(["1600.00", "200.00", "1400.00"]);
  });

  it("refuses a negative net instead of capping silently", () => {
    expect(code(() => calculateSlip(base({ adjustments: [{ kind: "OTHER_DEDUCTION", amount: "40000" }] })))).toBe("NEGATIVE_NET");
  });

  it("refuses bad inputs: no days, days out of range, bad amounts, percent over 100, zero adjustments", () => {
    expect(code(() => calculateSlip(base({ monthDays: 0 })))).toBe("NO_DAYS");
    expect(code(() => calculateSlip(base({ lopDays: "20", offRollsDays: 7 })))).toBe("DAYS_OUT_OF_RANGE");
    expect(code(() => calculateSlip(base({ lopDays: "1.25" })))).toBe("DAYS_OUT_OF_RANGE");
    expect(code(() => calculateSlip(base({ offRollsDays: -1 })))).toBe("DAYS_OUT_OF_RANGE");
    expect(code(() => calculateSlip(base({ basic: "-1" })))).toBe("BAD_AMOUNT");
    expect(code(() => calculateSlip(base({ basic: "1e5" })))).toBe("BAD_AMOUNT");
    expect(code(() => calculateSlip(base({ basic: "100.005" })))).toBe("BAD_AMOUNT");
    expect(code(() => calculateSlip(base({ items: [{ ...ITEMS[0], value: "100.01" }] })))).toBe("BAD_PERCENT");
    expect(code(() => calculateSlip(base({ adjustments: [{ kind: "BONUS", amount: "0" }] })))).toBe("BAD_AMOUNT");
  });

  it("stays exact for large salaries (no float drift)", () => {
    const s = calculateSlip({ basic: "9999999.99", items: [], monthDays: 31, offRollsDays: 0, lopDays: "0.5", adjustments: [] });
    expect(s.net).toBe("9838709.67"); // 9999999.99 × 30.5/31 = 9838709.667…
  });
});

describe("slipDays (P3 basis)", () => {
  // November 2026: Sundays off (5), staff holiday on the 14th → 24 working days, 30 calendar days.
  const days = classifyRange("2026-11-01", "2026-11-30", { days: [0], saturdays: [] }, new Set(["2026-11-14"]));
  const joinsOn16 = (d: string) => d >= "2026-11-16";
  it("working-day basis counts working days only", () => {
    expect(slipDays("WORKING_DAYS", days, joinsOn16, "1")).toEqual({ monthDays: 24, offRollsDays: 11, lopDays: "1" });
  });
  it("calendar basis counts every day", () => {
    expect(slipDays("CALENDAR_DAYS", days, joinsOn16, "1")).toEqual({ monthDays: 30, offRollsDays: 15, lopDays: "1" });
  });
});
