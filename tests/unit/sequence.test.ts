import { describe, expect, it } from "vitest";
import { formatSequence, sequenceKey, validateFormat } from "@/lib/sequence";

describe("formatSequence", () => {
  it("renders the default student ID format", () => {
    expect(formatSequence("{CODE}-{YYYY}-{SEQ:4}", 1, { code: "JNV", year: 2026 })).toBe("JNV-2026-0001");
    expect(formatSequence("{CODE}-{YYYY}-{SEQ:4}", 3, { code: "JNV", year: 2026 })).toBe("JNV-2026-0003");
  });
  it("never truncates past the padding width", () => {
    expect(formatSequence("{CODE}-{SEQ:4}", 10000, { code: "X" })).toBe("X-10000");
  });
  it("supports YY, SESSION and CLASS tokens", () => {
    expect(
      formatSequence("R/{SESSION}/{CLASS}/{YY}/{SEQ:3}", 7, { session: "2026-27", className: "6", year: 2026 }),
    ).toBe("R/2026-27/6/26/007");
  });
  it("throws when a token value is missing", () => {
    expect(() => formatSequence("{CODE}-{SEQ}", 1, {})).toThrow(/CODE/);
  });
});

describe("validateFormat", () => {
  it("requires exactly one SEQ token", () => {
    expect(validateFormat("{CODE}-{YYYY}")).toMatch(/SEQ/);
    expect(validateFormat("{SEQ}-{SEQ:2}")).toMatch(/SEQ/);
    expect(validateFormat("{CODE}-{SEQ:4}")).toBeNull();
  });
  it("rejects unknown tokens", () => {
    expect(validateFormat("{CODE}-{FOO}-{SEQ}")).toMatch(/FOO/);
  });
});

describe("sequenceKey", () => {
  it("resets per year when the format includes the year", () => {
    expect(sequenceKey("student_id", "{CODE}-{YYYY}-{SEQ:4}", { year: 2026 })).toBe("student_id:2026");
  });
  it("uses a single global counter otherwise", () => {
    expect(sequenceKey("employee_code", "EMP-{SEQ:4}", {})).toBe("employee_code:all");
  });
});
