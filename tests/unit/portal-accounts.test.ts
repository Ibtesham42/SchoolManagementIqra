import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVATION_CODE_LENGTH,
  UNUSABLE_PASSWORD_HASH,
  formatActivationCode,
  generateActivationCode,
  hashActivationCode,
  isActivationUsable,
  isUsablePasswordHash,
  normalizeActivationCode,
} from "@/lib/auth/activation-code";
import { verifyPassword } from "@/lib/auth/password";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@/lib/errors";
import { portalSlipErrorCode } from "@/lib/http/portal-slip-errors";
import { RULES } from "@/lib/rate-limit";
import { activateAccountSchema } from "@/modules/identity/activation.schemas";
import { guardianSlipSchema, sectionSlipsSchema } from "@/modules/students/family-accounts.schemas";
import { familyAccountStatus, suggestedUsername } from "@/modules/students/family-accounts.service";

/** Phase 6A-M3a — activation codes, account states, slip error codes, schemas and static guards (ADR-046). */

describe("activation codes", () => {
  it("12 characters, capitals and digits without look-alikes, from the CSPRNG", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const c = generateActivationCode();
      expect(c).toMatch(/^[A-HJKMNP-Z2-9]{12}$/);
      expect(c).not.toMatch(/[01IOL]/);
      seen.add(c);
    }
    expect(seen.size).toBe(200);
    expect(generateActivationCode(() => 0)).toBe("A".repeat(ACTIVATION_CODE_LENGTH));
  });

  it("typing from paper: case, spaces and dashes don't matter; anything else is no code", () => {
    expect(normalizeActivationCode(" abcd-efgh jkmn ")).toBe("ABCDEFGHJKMN");
    expect(normalizeActivationCode("ABCD-EFGH-JKM")).toBe(""); // too short
    expect(normalizeActivationCode("ABCD-EFGH-JKMO")).toBe(""); // O is not in the alphabet
    expect(normalizeActivationCode("ABCD-EFGH-JKMN-P")).toBe("");
    expect(formatActivationCode("ABCDEFGHJKMN")).toBe("ABCD-EFGH-JKMN");
  });

  it("only a domain-separated SHA-256 is stored", () => {
    const h = hashActivationCode("ABCDEFGHJKMN");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(hashActivationCode("ABCDEFGHJKMN"));
    expect(h).not.toBe(hashActivationCode("ABCDEFGHJKMP"));
  });

  it("a code works only while unused and unexpired", () => {
    const now = new Date("2026-11-23T10:00:00Z");
    expect(isActivationUsable({ usedAt: null, expiresAt: new Date("2026-11-24T00:00:00Z") }, now)).toBe(true);
    expect(isActivationUsable({ usedAt: now, expiresAt: new Date("2026-11-24T00:00:00Z") }, now)).toBe(false);
    expect(isActivationUsable({ usedAt: null, expiresAt: now }, now)).toBe(false);
    expect(isActivationUsable(null, now)).toBe(false);
  });

  it("an account awaiting activation has no password that could ever verify", async () => {
    expect(isUsablePasswordHash(UNUSABLE_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword(UNUSABLE_PASSWORD_HASH, UNUSABLE_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword(UNUSABLE_PASSWORD_HASH, "")).toBe(false);
  });

  it("rate limits for the public form exist (per IP and per username)", () => {
    expect(RULES.activationPerIp).toMatchObject({ limit: 10, windowSeconds: 3600 });
    // Review 6A-M4 L1: attempts per (username, IP); failures per username with a higher ceiling (the login model).
    expect(RULES.activationPerUserIp).toMatchObject({ limit: 10, windowSeconds: 3600 });
    expect(RULES.activationFailuresPerUser).toMatchObject({ limit: 30, windowSeconds: 3600 });

    expect(RULES.portalSlips.limit).toBeGreaterThan(0);
  });
});

describe("account states and usernames", () => {
  const base = { id: "u", username: "9876543210", isActive: true, activatedAt: null, pendingCodeExpiresAt: null, everActivated: false };
  it("status truth table", () => {
    expect(familyAccountStatus(null)).toBe("NONE");
    expect(familyAccountStatus({ ...base, pendingCodeExpiresAt: new Date() })).toBe("PENDING");
    expect(familyAccountStatus(base)).toBe("EXPIRED");
    expect(familyAccountStatus({ ...base, activatedAt: new Date() })).toBe("ACTIVE");
    expect(familyAccountStatus({ ...base, activatedAt: new Date(), pendingCodeExpiresAt: new Date() })).toBe("ACTIVE"); // reset slip outstanding
    expect(familyAccountStatus({ ...base, isActive: false, activatedAt: new Date() })).toBe("DEACTIVATED");
  });

  it("the suggested username is the 10-digit mobile number only", () => {
    expect(suggestedUsername("9876543210")).toBe("9876543210");
    expect(suggestedUsername("98765")).toBeNull();
    expect(suggestedUsername("")).toBeNull();
  });
});

describe("schemas", () => {
  it("activation needs explicit consent and an ISO date", () => {
    const ok = { username: "9876543210", code: "ABCD-EFGH-JKMN", dob: "2015-04-01", consent: true, newPassword: "x".repeat(10), confirmPassword: "x".repeat(10) };
    expect(activateAccountSchema.safeParse(ok).success).toBe(true);
    expect(activateAccountSchema.safeParse({ ...ok, consent: false }).success).toBe(false);
    expect(activateAccountSchema.safeParse({ ...ok, dob: "01/04/2015" }).success).toBe(false);
    expect(activateAccountSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it("slip requests are strict; an empty username means 'use the mobile number'", () => {
    expect(guardianSlipSchema.parse({ studentId: "s", guardianId: "g", mode: "create", username: "" }).username).toBeNull();
    expect(guardianSlipSchema.parse({ studentId: "s", guardianId: "g", mode: "create", username: " Asha.P " }).username).toBe("asha.p");
    expect(guardianSlipSchema.safeParse({ studentId: "s", guardianId: "g", mode: "create", username: "a b" }).success).toBe(false);
    expect(guardianSlipSchema.safeParse({ studentId: "s", guardianId: "g", mode: "delete" }).success).toBe(false);
    expect(sectionSlipsSchema.parse({ sectionId: "x" }).reissuePending).toBe(false);
  });
});

describe("slip outcomes are fixed codes", () => {
  it("maps errors without echoing messages", () => {
    expect(portalSlipErrorCode(new ValidationError("taken", [{ path: "username", message: "x" }]))).toBe("username");
    expect(portalSlipErrorCode(new ValidationError("This section has more than 80 students; issue slips per student."))).toBe("too_many");
    expect(portalSlipErrorCode(new ValidationError("bad"))).toBe("invalid");
    expect(portalSlipErrorCode(new ValidationError("no child", [{ path: "guardianId", message: "x" }]))).toBe("blocked");
    expect(portalSlipErrorCode(new ConflictError("This guardian already has a portal account."))).toBe("exists");
    expect(portalSlipErrorCode(new ConflictError("This portal account is deactivated. Reactivate it first."))).toBe("deactivated");
    expect(portalSlipErrorCode(new ForbiddenError())).toBe("forbidden");
    expect(portalSlipErrorCode(new NotFoundError())).toBe("not_found");
    expect(portalSlipErrorCode(new RateLimitedError())).toBe("rate_limited");
    expect(portalSlipErrorCode(new Error("x"))).toBe("failed");
  });
});

// ── static guards ──
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readFileSync(join(ROOT, "src", ...p), "utf8");

describe("static guards (ADR-046)", () => {
  it("audit rows never carry a code, a date of birth or a password", () => {
    for (const file of [src("modules", "identity", "portal-accounts.tx.ts"), src("modules", "identity", "activation.service.ts"), src("modules", "students", "family-accounts.service.ts")]) {
      for (const call of file.match(/audit\(tx,[\s\S]*?\}\);/g) ?? []) expect(call).not.toMatch(/\bcode\b|codeHash|dob|password/i);
    }
  });

  it("activation: rate limits and Argon2 come before any account lookup; one generic error", () => {
    const s = src("modules", "identity", "activation.service.ts");
    const body = s.slice(s.indexOf("export async function activatePortalAccount"));
    expect(body.indexOf("RULES.activationPerIp")).toBeLessThan(body.indexOf("$transaction"));
    expect(body.indexOf("RULES.activationPerUserIp")).toBeLessThan(body.indexOf("$transaction"));
    expect(body.indexOf("RULES.activationFailuresPerUser")).toBeLessThan(body.indexOf("$transaction"));
    expect(body.indexOf("hashPassword(")).toBeLessThan(body.indexOf("$transaction"));
    expect(body).toMatch(/FOR UPDATE[\s\S]*account_activation[\s\S]*FOR UPDATE/);
    expect(s).toMatch(/async function failed\(username: string\): Promise<never> \{\s*await hit\(RULES\.activationFailuresPerUser, username\);\s*throw new ActivationFailedError\(\);/);
    // Review M1: a wrong code returns before anything is counted; only a wrong DOB with the right code counts.
    expect(body).toMatch(/if \(!sameHash\(row\.code_hash, codeHash\)\) return \{ ok: false \};\s*if \(!dobs\.includes\(input\.dob\)\) \{/);
    // Review L2: password checks before the per-username bucket.
    expect(body.indexOf("passwordProblem(")).toBeLessThan(body.indexOf("RULES.activationPerUserIp"));
    // Review L3: unknown / ineligible usernames take the equalized path.
    expect(body.match(/return equalizedFailure\(tx\)/g)?.length).toBe(3); // + no live code (review 6A-M4 L4)
    expect(body.match(/return failed\(input\.username\)/g)?.length).toBe(2); // every failure counts on the failure bucket
  });

  it("review M2: /erp/users can't reset or switch a portal account; unconsented portal accounts get no session or login", () => {
    const u = src("modules", "identity", "users.service.ts");
    for (const fn of ["export async function setUserActive", "export async function adminResetPassword", "export async function updateUser"]) {
      const body = u.slice(u.indexOf(fn), u.indexOf("\n}\n", u.indexOf(fn)));
      expect(body, fn).toMatch(/assertNotPortalAccount\(target\)/);
    }
    expect(src("lib", "auth", "session.ts")).toMatch(/const unconsented = !!portal && !user\.privacyConsentAt;/);
    // Review 6A-M4 M1: no email reset for portal accounts at all.
    expect(src("modules", "identity", "password-reset.service.ts")).toMatch(/if \(accountKindOf\(user\.roles\.map\(\(r\) => r\.role\.key\)\) !== "STAFF"\) return;/);
    expect(src("modules", "identity", "auth.service.ts")).toMatch(/accountKindOf\(roleKeysAll\) !== "STAFF" && !user\.privacyConsentAt\) return fail\(\)/);
  });

  it("login and email reset treat an unactivated account like a wrong password / no account", () => {
    expect(src("modules", "identity", "auth.service.ts")).toMatch(/if \(!isUsablePasswordHash\(user\.passwordHash\)\) await burnPasswordCheck/);
    expect(src("modules", "identity", "password-reset.service.ts")).toMatch(/if \(!isUsablePasswordHash\(user\.passwordHash\)\) return;/);
  });

  it("the slip route: same origin, session, rate limit and a bounded body before the service; PDF as an attachment", () => {
    const r = src("app", "api", "v1", "portal-accounts", "slips", "route.ts");
    const order = ["assertSameOrigin(", "getAuthContext()", "readBodyWithLimit(", "RULES.portalSlips", "issueGuardianSlip("].map((k) => r.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(r).toMatch(/pdfResponse\(.*"portal-activation-slips\.pdf", "attachment"\)/);
  });

  it("the activation page keeps the fragment out of history and never reads a query string code", () => {
    const f = src("app", "(auth)", "activate", "activate-form.tsx");
    expect(f).toMatch(/history\.replaceState/);
    expect(f).not.toMatch(/searchParams|location\.search\)\.get/);
  });
});

describe("activation slip PDF", () => {
  it("one page per guardian: name, children, username, code; never a date of birth", async () => {
    const { createElement } = await import("react");
    const { renderPdf } = await import("@/lib/pdf/render");
    const { buildBranding } = await import("@/modules/documents/branding");
    const { FALLBACK_PROFILE } = await import("@/modules/settings/settings.public");
    const { ActivationSlipsDocument } = await import("@/modules/documents/templates/activation-slip");
    const { extractTextRuns, nonWinAnsiChars, pageText } = await import("../pdf-text");
    const slips = [
      { guardianName: "Synthetic Parent One", children: ["Synthetic Child A", "Synthetic Child B"], username: "9000000001", code: "ABCD-EFGH-JKMN", expiresOn: "2026-12-14" },
      { guardianName: "Synthetic Parent Two", children: ["Synthetic Child C"], username: "synthetic.two", code: "PQRS-TUVW-XYZ2", expiresOn: "2026-12-14" },
    ];
    const pdf = await renderPdf(createElement(ActivationSlipsDocument, { branding: buildBranding(FALLBACK_PROFILE), slips, activateUrl: "https://school.example/activate", consentVersion: "1", generatedAt: new Date() }));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const runs = extractTextRuns(pdf);
    const one = pageText(runs, 1);
    const two = pageText(runs, 2);
    for (const t of ["Synthetic Parent One", "Synthetic Child A, Synthetic Child B", "9000000001", "ABCD-EFGH-JKMN", "https://school.example/activate"]) expect(one).toContain(t);
    expect(two).toContain("PQRS-TUVW-XYZ2");
    expect(one).not.toContain("PQRS-TUVW-XYZ2");
    expect(nonWinAnsiChars(one + two)).toEqual([]);
    expect(one).not.toMatch(/date of birth:|\b20\d\d-\d\d-\d\d\b/i);
  });
});
