import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant } from "@/lib/rbac/catalog";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import {
  configuredVerificationKeyVersions,
  currentVerificationKeyVersion,
  formatVerificationCode,
  generateVerificationCode,
  hashVerificationCode,
  normalizeVerificationCode,
  parseRotatedKeyName,
  verificationHashCandidates,
} from "@/lib/verification-code";

// Unit scope: pure code handling, key versioning and the public answer. Issue/revoke/verify against
// the registry table are integration tests (tests/integration/documents.test.ts), pending a database.
const { toPublicVerification, revokeDocument, issueDocument, matchVerificationRow } = await import("@/modules/documents/documents.service");

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const KEY_A = Buffer.alloc(32, 7).toString("base64"); // synthetic test keys
const KEY_B = Buffer.alloc(32, 9).toString("base64");
const KEY_VARS = ["DOCUMENT_VERIFICATION_KEY", "DOCUMENT_VERIFICATION_KEY_VERSION", "DOCUMENT_VERIFICATION_KEY_V1", "DOCUMENT_VERIFICATION_KEY_V2", "DATA_HMAC_KEY"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  process.env.DOCUMENT_VERIFICATION_KEY = KEY_A;
  process.env.DOCUMENT_VERIFICATION_KEY_VERSION = "1";
  delete process.env.DOCUMENT_VERIFICATION_KEY_V1;
  delete process.env.DOCUMENT_VERIFICATION_KEY_V2;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Simulates a rotation: v1 key moves to DOCUMENT_VERIFICATION_KEY_V1, a new current key at v2. */
function rotateToV2() {
  process.env.DOCUMENT_VERIFICATION_KEY_V1 = KEY_A;
  process.env.DOCUMENT_VERIFICATION_KEY = KEY_B;
  process.env.DOCUMENT_VERIFICATION_KEY_VERSION = "2";
}

describe("verification codes", () => {
  it("are 16 Crockford base32 characters (80 bits) from the CSPRNG, without look-alike letters", () => {
    const codes = new Set(Array.from({ length: 2000 }, () => generateVerificationCode()));
    expect(codes.size).toBe(2000);
    for (const c of codes) expect(c).toMatch(CROCKFORD);
  });
  it("encode every input bit (all-zero and all-one bytes map to the alphabet ends)", () => {
    expect(generateVerificationCode((n) => Buffer.alloc(n, 0))).toBe("0".repeat(16));
    expect(generateVerificationCode((n) => Buffer.alloc(n, 0xff))).toBe("Z".repeat(16));
  });
  it("are displayed in groups of four and normalized from typed input", () => {
    const code = "7K3MQ9TX2B4RHJ6N";
    expect(formatVerificationCode(code)).toBe("7K3M-Q9TX-2B4R-HJ6N");
    expect(normalizeVerificationCode("7k3m q9tx-2b4r hj6n")).toBe(code);
    expect(normalizeVerificationCode("OIL0-0000-0000-0000")).toBe("0110000000000000"); // O→0, I/L→1
  });
  it("reject malformed input without any lookup", () => {
    for (const bad of ["", "short", "7K3M-Q9TX-2B4R-HJ6", "7K3M-Q9TX-2B4R-HJ6NX", "7K3M-Q9TX-2B4R-HJ6U", "'; DROP TABLE x;--", "x".repeat(500)]) {
      expect(normalizeVerificationCode(bad)).toBeNull();
    }
  });
  it("are stored only as a keyed hash: deterministic, 64 hex chars, never containing the code", () => {
    const code = generateVerificationCode();
    const h = hashVerificationCode(code);
    expect(h).toMatch(/^[0-9a-f]{64}$/); // matches the generated_document_code_hash_format CHECK
    expect(h).toBe(hashVerificationCode(code));
    expect(h).not.toContain(code.toLowerCase());
    expect(hashVerificationCode(generateVerificationCode())).not.toBe(h);
  });
});

describe("verification key (dedicated, versioned)", () => {
  const code = "7K3MQ9TX2B4RHJ6N";

  it("uses DOCUMENT_VERIFICATION_KEY, not DATA_HMAC_KEY", () => {
    const h = hashVerificationCode(code);
    process.env.DATA_HMAC_KEY = KEY_B; // changing the general lookup key has no effect
    expect(hashVerificationCode(code)).toBe(h);
    process.env.DOCUMENT_VERIFICATION_KEY = KEY_B; // changing the verification key does
    expect(hashVerificationCode(code)).not.toBe(h);
  });
  it("fails closed when the key is missing or the version is invalid", () => {
    delete process.env.DOCUMENT_VERIFICATION_KEY;
    expect(() => hashVerificationCode(code)).toThrow(/DOCUMENT_VERIFICATION_KEY is not set/);
    process.env.DOCUMENT_VERIFICATION_KEY = KEY_A;
    for (const v of ["0", "-1", "1.5", "abc", "40000"]) {
      process.env.DOCUMENT_VERIFICATION_KEY_VERSION = v;
      expect(() => currentVerificationKeyVersion()).toThrow(/DOCUMENT_VERIFICATION_KEY_VERSION/);
    }
  });
  it("a key version without its configured key can't be used (no silent fallback)", () => {
    expect(() => hashVerificationCode(code, 2)).toThrow(/DOCUMENT_VERIFICATION_KEY_V2 is not set/);
  });
  it("after rotation, new codes use v2 and codes issued under v1 still verify", () => {
    const v1Hash = hashVerificationCode(code); // issued before rotation, stored with version 1
    rotateToV2();
    expect(currentVerificationKeyVersion()).toBe(2);
    expect(configuredVerificationKeyVersions()).toEqual([2, 1]);
    expect(hashVerificationCode(code, 1)).toBe(v1Hash); // old key still reproduces the stored hash
    expect(hashVerificationCode(code)).not.toBe(v1Hash); // new documents get a v2 hash
    const candidates = verificationHashCandidates(code);
    expect(candidates.map((c) => c.version)).toEqual([2, 1]);
    const stored = [{ verificationCodeHash: v1Hash, verificationKeyVersion: 1, id: "old" }];
    expect(matchVerificationRow(stored, candidates)?.id).toBe("old");
  });
  it("removing a rotated-out key makes only that version's documents unverifiable", () => {
    const v1Hash = hashVerificationCode(code);
    rotateToV2();
    const v2Hash = hashVerificationCode(code);
    delete process.env.DOCUMENT_VERIFICATION_KEY_V1;
    const candidates = verificationHashCandidates(code);
    expect(candidates.map((c) => c.version)).toEqual([2]);
    expect(matchVerificationRow([{ verificationCodeHash: v1Hash, verificationKeyVersion: 1 }], candidates)).toBeNull();
    expect(matchVerificationRow([{ verificationCodeHash: v2Hash, verificationKeyVersion: 2 }], candidates)).not.toBeNull();
  });
  it.each(["DOCUMENT_VERIFICATION_KEY_V01", "DOCUMENT_VERIFICATION_KEY_V+1", "DOCUMENT_VERIFICATION_KEY_V1.0", "DOCUMENT_VERIFICATION_KEY_V 1"])(
    "a non-canonical old-key name (%s) is ignored instead of breaking every verification",
    (name) => {
      process.env.DOCUMENT_VERIFICATION_KEY = KEY_B;
      process.env.DOCUMENT_VERIFICATION_KEY_VERSION = "2";
      process.env[name] = KEY_A;
      try {
        expect(configuredVerificationKeyVersions()).toEqual([2]);
        expect(() => verificationHashCandidates(code)).not.toThrow();
      } finally {
        delete process.env[name];
      }
    },
  );
  it("DOCUMENT_VERIFICATION_KEY_VERSION itself is never mistaken for a rotated key", () => {
    expect(parseRotatedKeyName("DOCUMENT_VERIFICATION_KEY_VERSION")).toBeNull();
    expect(parseRotatedKeyName("DOCUMENT_VERIFICATION_KEY_V7")).toBe(7);
    expect(parseRotatedKeyName("DOCUMENT_VERIFICATION_KEY_V32767")).toBe(32767);
    expect(parseRotatedKeyName("DOCUMENT_VERIFICATION_KEY_V32768")).toBeNull();
  });
  it("old-key versions outside the column range (SmallInt) are ignored", () => {
    process.env.DOCUMENT_VERIFICATION_KEY_V40000 = KEY_A;
    try {
      expect(configuredVerificationKeyVersions()).toEqual([1]);
    } finally {
      delete process.env.DOCUMENT_VERIFICATION_KEY_V40000;
    }
  });
  it("survives a restart: nothing is cached, keys are re-read from the environment", async () => {
    const v1Hash = hashVerificationCode(code);
    rotateToV2();
    vi.resetModules(); // a fresh process loads the module again
    const fresh = await import("@/lib/verification-code");
    expect(fresh.verificationHashCandidates(code).find((c) => c.version === 1)?.hash).toBe(v1Hash);
  });
  it("a row matches only under the key version it records", () => {
    const v1Hash = hashVerificationCode(code);
    rotateToV2();
    const candidates = verificationHashCandidates(code);
    // Same hash but a mislabelled version (tampering or bug) must not verify.
    expect(matchVerificationRow([{ verificationCodeHash: v1Hash, verificationKeyVersion: 2 }], candidates)).toBeNull();
    expect(matchVerificationRow([], candidates)).toBeNull();
  });
});

describe("public verification answer", () => {
  const issued = { type: "CERTIFICATE" as const, generatedAt: new Date("2026-11-08T20:00:00Z"), revokedAt: null };

  it("valid: only type, issue date (school time zone) and issuer — no names, ids or files", () => {
    const v = toPublicVerification(issued, "Demo Public School", "Asia/Kolkata");
    expect(v).toEqual({ status: "valid", type: "CERTIFICATE", issuedOn: "2026-11-09", issuer: "Demo Public School" });
    expect(Object.keys(v).sort()).toEqual(["issuedOn", "issuer", "status", "type"]);
  });
  it("revoked documents fail verification and reveal nothing else", () => {
    expect(toPublicVerification({ ...issued, revokedAt: new Date() }, "Demo Public School", "Asia/Kolkata")).toEqual({ status: "revoked" });
  });
  it("unknown codes report not_found", () => {
    expect(toPublicVerification(null, "Demo Public School", "Asia/Kolkata")).toEqual({ status: "not_found" });
  });
});

// Authorization is checked before any database access, so these run without a database.
function roleCtx(roleKey: string, opts: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const grants = role.grants.map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: normalizeGrant(g).key, scope: normalizeGrant(g).scope }));
  return { userId: `u-${roleKey}`, username: roleKey.toLowerCase(), displayName: roleKey, sessionId: "s", roleKeys: [roleKey], isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(grants), ...opts };
}

describe("document revocation authorization", () => {
  const cannotRevoke = ROLES.map((r) => r.key).filter((k) => k !== "SUPER_ADMIN" && k !== "PRINCIPAL");

  it.each(cannotRevoke)("%s cannot revoke (403 before any lookup)", async (role) => {
    await expect(revokeDocument(roleCtx(role), "doc1", "Issued in error")).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("School Admin and Admission Officer can generate but still cannot revoke", async () => {
    for (const role of ["SCHOOL_ADMIN", "ADMISSION_OFFICER"]) {
      await expect(revokeDocument(roleCtx(role), "doc1", "Issued in error")).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
  it("anonymous callers are rejected", async () => {
    await expect(revokeDocument(null as unknown as AuthContext, "doc1", "x")).rejects.toBeInstanceOf(UnauthenticatedError);
  });
  it("a forced password change blocks revocation even for Super Admin", async () => {
    await expect(revokeDocument(roleCtx("SUPER_ADMIN", { mustChangePassword: true }), "doc1", "Issued in error")).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("authorized roles still need a real reason (validated before the database)", async () => {
    await expect(revokeDocument(roleCtx("PRINCIPAL"), "doc1", "  ")).rejects.toBeInstanceOf(ValidationError);
    await expect(revokeDocument(roleCtx("SUPER_ADMIN"), "doc1", "x".repeat(501))).rejects.toBeInstanceOf(ValidationError);
  });
  it("issuing requires document.generate (Principal can revoke but not issue by default)", async () => {
    const render = async () => Buffer.from("%PDF-1.7");
    const input = { type: "OTHER" as const, subject: { type: "Student", id: "s1" }, fileName: "x.pdf" };
    await expect(issueDocument(roleCtx("PRINCIPAL"), input, render)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(issueDocument(roleCtx("TEACHER"), input, render)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
