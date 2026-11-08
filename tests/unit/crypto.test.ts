import { describe, expect, it } from "vitest";
import { decryptBuffer, decryptField, encryptBuffer, encryptField, lookupHash, maskTail, sha256Hex } from "@/lib/crypto";
import { redact } from "@/lib/audit";

describe("field encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptField("1234 5678 9012");
    const b = encryptField("1234 5678 9012");
    expect(a).not.toEqual(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptField(a)).toBe("1234 5678 9012");
  });
  it("detects tampering", () => {
    const enc = encryptField("secret value");
    const i = enc.length - 5;
    const tampered = enc.slice(0, i) + (enc[i] === "A" ? "B" : "A") + enc.slice(i + 1);
    expect(() => decryptField(tampered)).toThrow();
  });
  it("supports key rotation: old ciphertexts stay readable, new ones use the new key", async () => {
    const { randomBytes } = await import("node:crypto");
    const oldKey = process.env.DATA_ENCRYPTION_KEY!;
    const before = encryptField("rotate me");
    try {
      process.env.DATA_ENCRYPTION_KEY_V1 = oldKey;
      process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.DATA_ENCRYPTION_KEY_VERSION = "2";
      const after = encryptField("rotate me");
      expect(after.startsWith("v2.")).toBe(true);
      expect(decryptField(before)).toBe("rotate me"); // via DATA_ENCRYPTION_KEY_V1
      expect(decryptField(after)).toBe("rotate me");
      delete process.env.DATA_ENCRYPTION_KEY_V1;
      expect(() => decryptField(before)).toThrow(/DATA_ENCRYPTION_KEY_V1/); // old key removed → unreadable
    } finally {
      process.env.DATA_ENCRYPTION_KEY = oldKey;
      process.env.DATA_ENCRYPTION_KEY_VERSION = "1";
      delete process.env.DATA_ENCRYPTION_KEY_V1;
    }
  });
  it("rejects a ciphertext decrypted with the wrong key", async () => {
    const { randomBytes } = await import("node:crypto");
    const enc = encryptField("secret");
    const original = process.env.DATA_ENCRYPTION_KEY!;
    process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    try {
      expect(() => decryptField(enc)).toThrow();
    } finally {
      process.env.DATA_ENCRYPTION_KEY = original;
    }
  });
  it("encrypts file buffers", () => {
    const { data, keyVersion } = encryptBuffer(Buffer.from("pdf-bytes"));
    expect(decryptBuffer(data, keyVersion).toString()).toBe("pdf-bytes");
  });
});

describe("lookup hash", () => {
  it("is deterministic, keyed and whitespace-insensitive", () => {
    expect(lookupHash("1234 5678 9012")).toBe(lookupHash("123456789012"));
    expect(lookupHash("123456789012")).not.toBe(sha256Hex("123456789012"));
  });
});

describe("masking and redaction", () => {
  it("masks all but the last 4 digits", () => {
    expect(maskTail("123456789012")).toBe("XXXX-XXXX-9012");
  });
  it("redacts sensitive keys recursively", () => {
    expect(redact({ name: "A", passwordHash: "x", nested: { aadhaarEnc: "y", ok: 1 } })).toEqual({
      name: "A",
      passwordHash: "[REDACTED]",
      nested: { aadhaarEnc: "[REDACTED]", ok: 1 },
    });
  });
});
