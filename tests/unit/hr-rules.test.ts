import { describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  assertEmployeeDates,
  changedFields,
  cleanMasterName,
  masterNameKeyOf,
  masterNameProblem,
  planEmployeeCode,
  redactForAudit,
  renderEmployeeCode,
} from "@/modules/hr/hr.rules";

/** Phase 3A M2 pure rules (PHASE_3A_M1_SCHEMA_PROPOSAL.md §9, PHASE_3_PLAN.md §3a). Synthetic values only. */

const accept = (raw: string) => {
  const name = cleanMasterName(raw);
  expect(masterNameProblem(name), raw).toBeNull();
  return { name, key: masterNameKeyOf(name) };
};

describe("department / designation names — any script, Unicode-safe keys (§9)", () => {
  it("accepts Hindi, Bengali, Tamil, Khasi and English names", () => {
    for (const n of ["गणित विभाग", "বিজ্ঞান", "தமிழ் துறை", "Ka Jingpule Ïing", "Science & Maths (Senior)", "Office/Admin", "Teachers' Room", "Class 1-5"]) accept(n);
  });

  it("composed and decomposed spellings get the same key (Hindi nukta, Khasi diaeresis)", () => {
    const composed = accept("क़ानून"); // क़ as क + nukta (NFC keeps decomposed nukta forms canonical)
    const precomposed = accept("क़ानून"); // क़ as one code point
    expect(composed.key).toBe(precomposed.key);
    expect(accept("Ïing").key).toBe(accept("Ïing").key); // Ï vs I + combining diaeresis
  });

  it("is case-insensitive without locale surprises; full-width Latin folds", () => {
    expect(accept("Ïing").key).toBe(accept("ïing").key);
    expect(accept("SCIENCE").key).toBe(accept("science").key);
    expect(accept("ＳＣＩＥＮＣＥ").key).toBe(accept("science").key);
    expect(masterNameKeyOf("İstanbul")).toBe("i̇stanbul"); // locale-independent toLowerCase(), never Turkish rules
  });

  it("Latin and Devanagari never collide", () => {
    expect(accept("Ganit").key).not.toBe(accept("गणित").key);
  });

  it("cleans whitespace, zero-width space and BOM; keeps ZWJ/ZWNJ only between letters", () => {
    expect(cleanMasterName("  Office  Staff \t ")).toBe("Office Staff");
    expect(cleanMasterName("Sci​ence﻿")).toBe("Science");
    expect(cleanMasterName("‍Admin‌")).toBe("Admin"); // stray joiners at the edges removed
    expect(cleanMasterName("क्‍ष")).toBe("क्‍ष"); // between a mark and a letter: kept
    // Names that differ only by a joiner stay distinct (proposal §9 default — the joiner changes the spelling).
    expect(masterNameKeyOf("क्‍ष")).not.toBe(masterNameKeyOf("क्ष"));
  });

  it("security review L1: removing a stray joiner next to a space leaves no double or trailing space (DB CHECK shape)", () => {
    for (const [raw, clean] of [["Science ‍", "Science"], ["Arts ‍ Music", "Arts Music"], ["‌ Office", "Office"], ["A‍ ‌B", "A B"]] as const) {
      const name = cleanMasterName(raw);
      expect(name).toBe(clean);
      expect(name).toBe(name.trim().replace(/\s+/g, " "));
      expect(masterNameProblem(name)).toBeNull();
    }
  });

  it("refuses emoji, control characters, leading punctuation, empty and over-long names", () => {
    for (const bad of ["Science 🔬", "Sci\u0007ence", "-Office", ".", "", "x".repeat(81)]) {
      expect(masterNameProblem(cleanMasterName(bad)), JSON.stringify(bad)).not.toBeNull();
    }
    expect(masterNameProblem("x".repeat(80))).toBeNull();
  });

  it("the stored values satisfy the database shape CHECKs (NFC name, NFKC key, single spaces)", () => {
    for (const raw of ["  Khasi  Ïing ", "ＳＣＩ  Lab", "गणित   विभाग"]) {
      const { name, key } = accept(raw);
      expect(name.normalize("NFC")).toBe(name);
      expect(key.normalize("NFKC")).toBe(key);
      for (const v of [name, key]) expect(v).toBe(v.trim().replace(/\s+/g, " "));
    }
  });
});

describe("employee code (H3)", () => {
  const joining = new Date("2026-07-01T00:00:00.000Z");

  it("defaults to EMP-{YYYY}-{SEQ:4} with the JOINING year and a per-year counter", () => {
    const plan = planEmployeeCode({ configuredFormat: null, joiningDate: joining, schoolCode: "DPS" });
    expect(plan.key).toBe("employee_code:2026");
    expect(renderEmployeeCode(plan, 1)).toBe("EMP-2026-0001");
    expect(renderEmployeeCode(plan, 12345)).toBe("EMP-2026-12345"); // never truncated
    expect(planEmployeeCode({ configuredFormat: null, joiningDate: new Date("2027-01-02T00:00:00.000Z"), schoolCode: "DPS" }).key).toBe("employee_code:2027");
  });

  it("uses a configured format, including the school code", () => {
    const plan = planEmployeeCode({ configuredFormat: "{CODE}/T/{YY}/{SEQ:3}", joiningDate: joining, schoolCode: "DPS" });
    expect(renderEmployeeCode(plan, 7)).toBe("DPS/T/26/007");
    expect(planEmployeeCode({ configuredFormat: "STAFF-{SEQ:5}", joiningDate: joining, schoolCode: null }).key).toBe("employee_code:all");
  });

  it("refuses invalid formats, {SESSION}/{CLASS}, and {CODE} without a school code — never a silent default", () => {
    for (const f of ["EMP-{YYYY}", "EMP-{SEQ}-{SEQ}", "EMP-{FOO}-{SEQ}", "EMP-{SESSION}-{SEQ}", "EMP-{CLASS}-{SEQ}"]) {
      expect(() => planEmployeeCode({ configuredFormat: f, joiningDate: joining, schoolCode: "DPS" }), f).toThrow(ConflictError);
    }
    expect(() => planEmployeeCode({ configuredFormat: "{CODE}-{SEQ}", joiningDate: joining, schoolCode: null })).toThrow(/short code/);
  });
});

describe("employee dates (database CHECKs + §9)", () => {
  const today = "2026-11-18";
  const ok = { dob: "1985-04-10", joiningDate: "2026-06-01" };

  it("accepts valid dates, including a joining date up to 90 days ahead", () => {
    expect(() => assertEmployeeDates(ok, today)).not.toThrow();
    expect(() => assertEmployeeDates({ ...ok, joiningDate: "2027-02-16" }, today)).not.toThrow(); // +90 days
    expect(() => assertEmployeeDates({ ...ok, confirmationDate: "2026-06-01" }, today)).not.toThrow();
  });

  it.each([
    ["born before 1940", { ...ok, dob: "1939-12-31" }, "dob"],
    ["born on the joining date", { ...ok, dob: "2026-06-01" }, "dob"],
    ["joining more than 90 days ahead", { ...ok, joiningDate: "2027-02-17" }, "joiningDate"],
    ["confirmed before joining", { ...ok, confirmationDate: "2026-05-31" }, "confirmationDate"],
  ])("refuses %s", (_label, input, path) => {
    try {
      assertEmployeeDates(input, today);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details?.map((d) => d.path)).toContain(path);
    }
  });
});

describe("audit redaction and change detection", () => {
  it("never writes names, contact details, dates of birth or addresses to audit rows", () => {
    const out = redactForAudit({ firstName: "Asha", dob: "1985-04-10", personalPhone: "9876543210", workEmail: "a@example.invalid", address: { city: "X" }, departmentId: "d1", appointmentType: "PERMANENT" });
    expect(out).toEqual({ firstName: "[REDACTED]", dob: "[REDACTED]", personalPhone: "[REDACTED]", workEmail: "[REDACTED]", address: "[REDACTED]", departmentId: "d1", appointmentType: "[REDACTED]" });
  });

  it("security review L3: employment terms are personal tier in audit rows too; codes, ids and status stay", () => {
    expect(redactForAudit({ employeeCode: "EMP-2026-0001", departmentId: "d1", staffType: "TEACHING", employmentStatus: "ACTIVE", appointmentType: "CONTRACT", joiningDate: "2026-06-01", confirmationDate: null, leavingDate: "2027-01-01", leavingReason: "x" })).toEqual({
      employeeCode: "EMP-2026-0001",
      departmentId: "d1",
      staffType: "TEACHING",
      employmentStatus: "ACTIVE",
      appointmentType: "[REDACTED]",
      joiningDate: "[REDACTED]",
      confirmationDate: "[REDACTED]",
      leavingDate: "[REDACTED]",
      leavingReason: "[REDACTED]",
    });
  });

  it("changedFields reports only real changes (JSON-compared, null = undefined)", () => {
    expect(changedFields({ a: 1, b: { x: 1 }, c: null as string | null }, { a: 1, b: { x: 1 }, c: undefined })).toEqual({ before: {}, after: {} });
    expect(changedFields({ a: 1, b: { x: 1 } }, { a: 2, b: { x: 2 } })).toEqual({ before: { a: 1, b: { x: 1 } }, after: { a: 2, b: { x: 2 } } });
  });
});
