import { describe, expect, it } from "vitest";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { levelFor } from "@/lib/usage-policy";

describe("password policy", () => {
  it("enforces length, common passwords and username containment", () => {
    expect(passwordProblem("short")).toMatch(/at least/);
    expect(passwordProblem("password123")).toMatch(/common/);
    expect(passwordProblem("rajesh-strong-pass", "rajesh")).toMatch(/username/);
    expect(passwordProblem("correct horse battery")).toBeNull();
  });
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery")).toBe(true);
    expect(await verifyPassword(h, "wrong horse battery")).toBe(false);
    expect(await verifyPassword("not-a-hash", "x")).toBe(false);
  });
});

describe("free-tier usage levels", () => {
  it("warns at 80% and stops at the cap", () => {
    expect(levelFor(10, 100)).toBe("ok");
    expect(levelFor(80, 100)).toBe("warning");
    expect(levelFor(100, 100)).toBe("exhausted");
    expect(levelFor(0, 0)).toBe("exhausted"); // a disabled metric never allows calls
  });
});
