import { describe, expect, it } from "vitest";
import { amountInWordsIndian, formatIndianMoney, moneyString, round2, sumMoney, toMoney, wordsIndian } from "@/lib/money";
import { AllocationError, allocatePayment, outstandingOf, type OpenInvoice } from "@/modules/fees/allocation";
import { daysLate, invoiceTotals, lateFeeFor, priceLines } from "@/modules/fees/fee-calc";
import { billableInstallments, itemApplies, needsReference, normalizeBankName, normalizeReference, sessionGeneratesInvoices } from "@/modules/fees/fee-rules";

/** Phase 5A-M1 pure modules: money, concession / late-fee math, allocation, billing rules (PHASE_5_PLAN.md). */

describe("lib/money", () => {
  it("rounds half-up at 2 dp, sums exactly, formats Indian grouping", () => {
    expect(moneyString("0.005")).toBe("0.01");
    expect(moneyString("2.345")).toBe("2.35");
    expect(moneyString("-2.345")).toBe("-2.35");
    expect(round2("0.1").plus("0.2").toFixed(2)).toBe("0.30");
    expect(sumMoney(["0.10", "0.20", "1000.05"]).toFixed(2)).toBe("1000.35");
    expect(formatIndianMoney("1234567.5")).toBe("12,34,567.50");
    expect(formatIndianMoney("999")).toBe("999.00");
    expect(formatIndianMoney("100000")).toBe("1,00,000.00");
    expect(() => toMoney("1e3")).toThrow();
    expect(() => toMoney("10000000000")).toThrow(/out of range/);
  });
  it("amount in words (Indian system)", () => {
    expect(wordsIndian(0)).toBe("Zero");
    expect(amountInWordsIndian("1")).toBe("Rupees One Only");
    expect(amountInWordsIndian("100000")).toBe("Rupees One Lakh Only");
    expect(amountInWordsIndian("1250.50")).toBe("Rupees One Thousand Two Hundred Fifty and Paise Fifty Only");
    expect(amountInWordsIndian("9999999.99")).toBe("Rupees Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine and Paise Ninety Nine Only");
    expect(amountInWordsIndian("12345678")).toBe("Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight Only");
    expect(() => amountInWordsIndian("-1")).toThrow();
  });
});

describe("concessions and totals", () => {
  const lines = [
    { key: "a", categoryId: "TUI", amount: "1000.00" },
    { key: "b", categoryId: "LAB", amount: "300.00" },
    { key: "c", categoryId: "TUI", amount: "333.33" },
  ];
  it("percent before fixed, per line, half-up; never below zero; untouched categories stay", () => {
    const p = priceLines(lines, [
      { id: "fixed", calc: "FIXED", value: "500", categoryIds: ["TUI"] },
      { id: "pct", calc: "PERCENT", value: "10", categoryIds: ["TUI"] },
    ]);
    // 10 % first: 100.00 and 33.33 (33.333 → 33.33); then 500 fixed spread over TUI lines in order: 500 from line a.
    expect(p.map((l) => [l.key, l.concession, l.net])).toEqual([
      ["a", "600.00", "400.00"],
      ["b", "0.00", "300.00"],
      ["c", "33.33", "300.00"],
    ]);
  });
  it("a fixed amount larger than the lines is partly unused; percents cap at 100", () => {
    const p = priceLines(lines, [{ id: "f", calc: "FIXED", value: "5000", categoryIds: ["LAB"] }]);
    expect(p[1]).toMatchObject({ concession: "300.00", net: "0.00" });
    const q = priceLines(lines, [
      { id: "p1", calc: "PERCENT", value: "70", categoryIds: ["LAB"] },
      { id: "p2", calc: "PERCENT", value: "70", categoryIds: ["LAB"] },
    ]);
    expect(q[1]).toMatchObject({ concession: "300.00", net: "0.00" });
  });
  it("totals are sums of rounded lines: total = subtotal − concessions + late fee", () => {
    const t = invoiceTotals(lines, [{ id: "p", calc: "PERCENT", value: "12.5", categoryIds: ["TUI", "LAB"] }], "50");
    // 125.00 + 37.50 + 41.67 (41.66625 → 41.67)
    expect(t).toMatchObject({ subtotal: "1633.33", concessionTotal: "204.17", lateFee: "50.00", total: "1479.16" });
  });
});

describe("late fee (FC7)", () => {
  const rule = { graceDays: 5, calc: "PER_DAY" as const, value: "10", cap: "100" };
  it("nothing within the grace period; per day after it; capped", () => {
    expect(daysLate("2026-07-10", "2026-07-15", 5)).toBe(0);
    expect(daysLate("2026-07-10", "2026-07-16", 5)).toBe(1);
    expect(lateFeeFor(rule, "2026-07-10", "2026-07-15", "1000")).toBe("0.00");
    expect(lateFeeFor(rule, "2026-07-10", "2026-07-18", "1000")).toBe("30.00");
    expect(lateFeeFor(rule, "2026-07-10", "2026-09-01", "1000")).toBe("100.00");
  });
  it("flat once, percent of the balance (half-up), none when nothing is due or no rule", () => {
    expect(lateFeeFor({ graceDays: 0, calc: "FLAT", value: "75", cap: null }, "2026-07-10", "2026-07-11", "1")).toBe("75.00");
    expect(lateFeeFor({ graceDays: 0, calc: "PERCENT", value: "2.5", cap: null }, "2026-07-10", "2026-07-11", "1234.30")).toBe("30.86");
    expect(lateFeeFor(rule, "2026-07-10", "2026-12-01", "0")).toBe("0.00");
    expect(lateFeeFor(null, "2026-07-10", "2026-12-01", "500")).toBe("0.00");
  });
  it("month and year boundaries count calendar days", () => {
    expect(daysLate("2026-12-30", "2027-01-02", 0)).toBe(3);
    expect(daysLate("2028-02-28", "2028-03-01", 0)).toBe(2); // leap year
  });
});

describe("allocation (FC8, FC9)", () => {
  const invoices: OpenInvoice[] = [
    { id: "i2", invoiceNo: "INV-2", dueOn: "2026-08-10", items: [{ id: "i2a", kind: "STRUCTURE", sortOrder: 1, outstanding: "500.00" }] },
    {
      id: "i1",
      invoiceNo: "INV-1",
      dueOn: "2026-07-10",
      items: [
        { id: "i1late", kind: "LATE_FEE", sortOrder: 0, outstanding: "30.00" },
        { id: "i1a", kind: "STRUCTURE", sortOrder: 1, outstanding: "1000.00" },
        { id: "i1b", kind: "STRUCTURE", sortOrder: 2, outstanding: "200.50" },
      ],
    },
  ];
  it("oldest due first, items in order, late fee last, exact paise", () => {
    expect(allocatePayment("1250.75", invoices)).toEqual([
      { invoiceId: "i1", itemId: "i1a", amount: "1000.00" },
      { invoiceId: "i1", itemId: "i1b", amount: "200.50" },
      { invoiceId: "i1", itemId: "i1late", amount: "30.00" },
      { invoiceId: "i2", itemId: "i2a", amount: "20.25" },
    ]);
    const all = allocatePayment(outstandingOf(invoices).toFixed(2), invoices);
    expect(sumMoney(all.map((a) => a.amount)).toFixed(2)).toBe("1730.50");
  });
  it("the collector may limit it to chosen invoices", () => {
    expect(allocatePayment("100", invoices, ["i2"])).toEqual([{ invoiceId: "i2", itemId: "i2a", amount: "100.00" }]);
    expect(() => allocatePayment("100", invoices, ["gone"])).toThrow(AllocationError);
  });
  it("refuses over-payment, zero and nothing due", () => {
    expect(() => allocatePayment("1730.51", invoices)).toThrow(/more than what is due \(1730\.50\)/);
    expect(() => allocatePayment("0", invoices)).toThrow(/above zero/);
    expect(() => allocatePayment("10", [{ id: "x", invoiceNo: "X", dueOn: "2026-01-01", items: [{ id: "y", kind: "STRUCTURE", sortOrder: 0, outstanding: "0" }] }])).toThrow(/Nothing is due/);
  });
});

describe("billing rules (FC4, FC10, FC25)", () => {
  const inst = [
    { id: "apr", dueOn: "2026-04-10" },
    { id: "jul", dueOn: "2026-07-10" },
    { id: "oct", dueOn: "2026-10-10" },
  ];
  it("joiners from their enrollment date; leavers up to their leaving date; promoted / detained never", () => {
    expect(billableInstallments({ status: "ACTIVE", enrolledOn: "2026-04-01", leftOn: null, newAdmission: false }, inst).map((i) => i.id)).toEqual(["apr", "jul", "oct"]);
    expect(billableInstallments({ status: "ACTIVE", enrolledOn: "2026-06-15", leftOn: null, newAdmission: true }, inst).map((i) => i.id)).toEqual(["jul", "oct"]);
    expect(billableInstallments({ status: "LEFT", enrolledOn: "2026-04-01", leftOn: "2026-08-31", newAdmission: false }, inst).map((i) => i.id)).toEqual(["apr", "jul"]);
    expect(billableInstallments({ status: "PROMOTED", enrolledOn: "2026-04-01", leftOn: "2027-03-31", newAdmission: false }, inst)).toEqual([]);
    expect(billableInstallments({ status: "DETAINED", enrolledOn: "2026-04-01", leftOn: "2027-03-31", newAdmission: false }, inst)).toEqual([]);
  });
  it("new-admission and existing-student items; sessions that generate", () => {
    expect([itemApplies("ALL", true), itemApplies("NEW_ADMISSION", true), itemApplies("NEW_ADMISSION", false), itemApplies("EXISTING", false), itemApplies("EXISTING", true)]).toEqual([true, true, false, true, false]);
    expect([sessionGeneratesInvoices("PLANNED"), sessionGeneratesInvoices("ACTIVE"), sessionGeneratesInvoices("CLOSED")]).toEqual([true, true, false]);
  });
  it("references are normalized; cash needs none", () => {
    expect(normalizeReference(" upi 4021 7788 ")).toBe("UPI40217788");
    expect(normalizeReference("ab")).toBeNull();
    expect(normalizeReference("=cmd|x")).toBeNull();
    expect([needsReference("CASH"), needsReference("UPI"), needsReference("CHEQUE")]).toEqual([false, true, true]);
  });
});

describe("security review 5A fixes", () => {
  it("L1: money is at most 2 decimals and never a JS number", () => {
    expect(() => toMoney("100.005")).toThrow(/at most 2 decimals/);
    expect(() => toMoney(0.1 + 0.2 as unknown as string)).toThrow(/JS number/);
    expect(toMoney({ toString: () => "12.5" }).toFixed(2)).toBe("12.50");
    expect(() => allocatePayment("10.001", [{ id: "i", invoiceNo: "I", dueOn: "2026-01-01", items: [{ id: "x", kind: "STRUCTURE", sortOrder: 0, outstanding: "20.00" }] }])).toThrow();
  });
  it("L2: impossible dates are refused, not rolled over", () => {
    expect(() => daysLate("2026-02-31", "2026-03-05", 0)).toThrow(/calendar date/);
    expect(() => daysLate("2026-13-01", "2026-12-01", 0)).toThrow(/calendar date/);
    expect(() => lateFeeFor({ graceDays: 0, calc: "FLAT", value: "50", cap: null }, "2026-02-30", "2026-04-01", "100")).toThrow();
    expect(() => daysLate("2026-01-01", "2026-02-01", -1)).toThrow(/grace/);
  });
  it("L3: a per-day late fee needs a cap", () => {
    expect(() => lateFeeFor({ graceDays: 0, calc: "PER_DAY", value: "10", cap: null }, "2026-01-01", "2026-12-31", "100")).toThrow(/needs a cap/);
  });
  it("L4: concession values must be above zero; percents may have decimals", () => {
    expect(() => priceLines([{ key: "a", categoryId: "T", amount: "100" }], [{ id: "n", calc: "PERCENT", value: "0", categoryIds: ["T"] }])).toThrow(/above zero/);
    expect(() => priceLines([{ key: "a", categoryId: "T", amount: "100" }], [{ id: "n", calc: "FIXED", value: "-5", categoryIds: ["T"] }])).toThrow();
    expect(priceLines([{ key: "a", categoryId: "T", amount: "100.00" }], [{ id: "p", calc: "PERCENT", value: "33.3333", categoryIds: ["T"] }])[0].concession).toBe("33.33");
  });
  it("M3: a FIXED concession is per invoice — twelve installments get it twelve times", () => {
    const monthly = Array.from({ length: 12 }, (_, i) => invoiceTotals([{ key: `m${i}`, categoryId: "T", amount: "2000" }], [{ id: "f", calc: "FIXED", value: "500", categoryIds: ["T"] }]));
    expect(sumMoney(monthly.map((t) => t.concessionTotal)).toFixed(2)).toBe("6000.00");
  });
  it("L6 / M4: references never start with a formula character; bank names are normalized", () => {
    expect(normalizeReference("-1-1")).toBeNull();
    expect(normalizeReference("@SUM")).toBeNull();
    expect(normalizeReference("chq/004512")).toBe("CHQ/004512");
    expect(normalizeBankName("  state   bank of india ")).toBe("STATE BANK OF INDIA");
    expect(normalizeBankName("=HYPERLINK()")).toBeNull();
  });
  it("I6: invoice order doesn't depend on the locale", () => {
    const inv = (id: string, no: string): OpenInvoice => ({ id, invoiceNo: no, dueOn: "2026-07-10", items: [{ id: `${id}x`, kind: "STRUCTURE", sortOrder: 0, outstanding: "10.00" }] });
    expect(allocatePayment("10", [inv("b", "inv-2"), inv("a", "INV-10")]).map((x) => x.invoiceId)).toEqual(["a"]);
  });
});
