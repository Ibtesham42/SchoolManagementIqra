import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateTemporaryPassword } from "@/lib/auth/temp-password";
import { passwordProblem } from "@/lib/auth/password";
import { isAuthorizedCron } from "@/lib/maintenance";
import { maskEmail, sendEmail } from "@/lib/email";
import { fromError, fromZod } from "@/lib/action-state";
import { ConflictError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/db-errors";
import { isResetTokenUsable, resetLink } from "@/modules/identity/password-reset.service";
import { createUserSchema, setRolePermissionsSchema } from "@/modules/identity/identity.schemas";

afterEach(() => vi.unstubAllEnvs());

describe("temporary passwords", () => {
  it("are random, readable and pass the password policy", () => {
    const set = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(set.size).toBe(200);
    for (const p of set) {
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      expect(p).not.toMatch(/[0O1lI]/);
      expect(passwordProblem(p)).toBeNull();
    }
  });
});

describe("password reset tokens", () => {
  const now = new Date("2026-11-08T10:00:00Z");
  it("usable only when unused and unexpired", () => {
    expect(isResetTokenUsable(null, now)).toBe(false);
    expect(isResetTokenUsable({ usedAt: null, expiresAt: new Date("2026-11-08T10:10:00Z") }, now)).toBe(true);
    expect(isResetTokenUsable({ usedAt: null, expiresAt: new Date("2026-11-08T09:59:59Z") }, now)).toBe(false);
    expect(isResetTokenUsable({ usedAt: new Date("2026-11-08T09:00:00Z"), expiresAt: new Date("2026-11-08T10:10:00Z") }, now)).toBe(false);
  });
  it("puts the token in the URL fragment (never sent to servers or logs) and URL-encodes it", () => {
    const link = resetLink("https://school.example.test/", "a+b/c");
    expect(link).toBe("https://school.example.test/reset-password#token=a%2Bb%2Fc");
    const url = new URL(link);
    expect(url.search).toBe(""); // nothing in the query string → nothing in access logs
    expect(url.hash).toContain("token=");
  });
});

describe("cron endpoint authorization", () => {
  const secret = "s".repeat(40);
  it("requires the exact bearer secret", () => {
    expect(isAuthorizedCron(`Bearer ${secret}`, secret)).toBe(true);
    expect(isAuthorizedCron(`Bearer ${secret}x`, secret)).toBe(false);
    expect(isAuthorizedCron(secret, secret)).toBe(false);
    expect(isAuthorizedCron(null, secret)).toBe(false);
  });
  it("is disabled when no (or a weak) secret is configured", () => {
    expect(isAuthorizedCron("Bearer anything", undefined)).toBe(false);
    expect(isAuthorizedCron("Bearer short", "short")).toBe(false);
  });
});

describe("email (log mode)", () => {
  const outbox = join(process.cwd(), "tmp", "outbox");
  it("writes the full message to tmp/outbox outside production", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "log");
    vi.stubEnv("NODE_ENV", "test");
    const before = existsSync(outbox) ? readdirSync(outbox).length : 0;
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r = await sendEmail({ to: "a@example.test", subject: "S", text: "link https://x/reset?token=abc", kind: "unit_test" });
    expect(r).toEqual({ delivered: true, provider: "log" });
    const files = readdirSync(outbox).filter((f) => f.endsWith("-unit_test.json"));
    expect(readdirSync(outbox).length).toBe(before + 1);
    const msg = JSON.parse(readFileSync(join(outbox, files.at(-1)!), "utf8"));
    expect(msg.text).toContain("token=abc");
    for (const f of files) rmSync(join(outbox, f));
  });
  it("never logs message bodies in production", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "log");
    vi.stubEnv("NODE_ENV", "production");
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r = await sendEmail({ to: "person@example.test", subject: "Reset", text: "SECRET-LINK", kind: "unit_test_prod" });
    expect(r.delivered).toBe(false);
    const logged = spy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("SECRET-LINK");
    expect(logged).not.toContain("person@example.test");
    expect(logged).toContain("p***@example.test");
  });
  it("'none' delivers nothing; resend without credentials refuses before any network call", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "none");
    expect((await sendEmail({ to: "a@b.test", subject: "x", text: "y", kind: "k" })).delivered).toBe(false);
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(sendEmail({ to: "a@b.test", subject: "x", text: "y", kind: "k" })).rejects.toThrow(/RESEND_API_KEY/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("masks addresses", () => {
    expect(maskEmail("teacher@school.example.test")).toBe("t***@school.example.test");
    expect(maskEmail("garbage")).toBe("***");
  });
});

describe("validation schemas", () => {
  it("normalizes usernames/emails and rejects bad input", () => {
    const ok = createUserSchema.parse({ username: " Asha.R ", displayName: "Asha R", email: " ASHA@Example.TEST ", roleKeys: ["TEACHER"] });
    expect(ok).toEqual({ username: "asha.r", displayName: "Asha R", email: "asha@example.test", roleKeys: ["TEACHER"] });
    expect(createUserSchema.parse({ username: "abc", displayName: "Ab", email: "", roleKeys: [] }).email).toBeNull();
    expect(createUserSchema.safeParse({ username: "a b", displayName: "Ab", email: "", roleKeys: [] }).success).toBe(false);
    expect(createUserSchema.safeParse({ username: "abc", displayName: "Ab", email: "not-an-email", roleKeys: [] }).success).toBe(false);
    expect(createUserSchema.safeParse({ username: "abc", displayName: "Ab", email: "", roleKeys: [], isSuperAdmin: true }).success).toBe(false); // strict
  });
  it("permission sets reject unknown keys, bad scopes and duplicates", () => {
    expect(setRolePermissionsSchema.safeParse({ id: "r", grants: [{ key: "student.read", scope: "ALL" }] }).success).toBe(true);
    expect(setRolePermissionsSchema.safeParse({ id: "r", grants: [{ key: "student.delete_everything", scope: "ALL" }] }).success).toBe(false);
    expect(setRolePermissionsSchema.safeParse({ id: "r", grants: [{ key: "student.read", scope: "GLOBAL" }] }).success).toBe(false);
    expect(
      setRolePermissionsSchema.safeParse({ id: "r", grants: [{ key: "student.read", scope: "ALL" }, { key: "student.read", scope: "SELF" }] }).success,
    ).toBe(false);
  });
});

describe("action error mapping", () => {
  it("shows AppError messages but hides unexpected errors", () => {
    expect(fromError(new ConflictError("That username is already taken.")).error).toBe("That username is already taken.");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const hidden = fromError(new Error("connect ECONNREFUSED 10.0.0.1:5432 password=hunter2"));
    expect(hidden.error).toBe("Something went wrong. Please try again.");
    expect(JSON.stringify(hidden)).not.toMatch(/ECONNREFUSED|hunter2/);
  });
  it("maps Zod issues to field errors", () => {
    const r = z.object({ email: z.email() }).safeParse({ email: "x" });
    expect(fromZod(r.error!).fieldErrors).toHaveProperty("email");
  });
  it("recognises unique violations from Prisma and pg", () => {
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["username"] } }, "username")).toBe(true);
    expect(isUniqueViolation({ code: "P2002", meta: { target: ["email"] } }, "username")).toBe(false);
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation(new Error("x"))).toBe(false);
  });
});
