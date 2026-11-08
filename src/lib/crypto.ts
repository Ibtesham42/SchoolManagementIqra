import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Application-level encryption for sensitive fields (Aadhaar, PAN, bank account) and
 * private files. AES-256-GCM, versioned so keys can be rotated (ADR-014).
 * Format: v<version>.<iv b64url>.<tag b64url>.<ciphertext b64url>
 */

function keyFromEnv(name: string): Buffer {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes (base64)`);
  return key;
}

function currentKeyVersion(): number {
  return Number(process.env.DATA_ENCRYPTION_KEY_VERSION ?? 1);
}

/** Older keys for rotation are provided as DATA_ENCRYPTION_KEY_V<n>. */
function keyForVersion(version: number): Buffer {
  return version === currentKeyVersion() ? keyFromEnv("DATA_ENCRYPTION_KEY") : keyFromEnv(`DATA_ENCRYPTION_KEY_V${version}`);
}

export function encryptBuffer(plain: Buffer): { data: Buffer; keyVersion: number } {
  const keyVersion = currentKeyVersion();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyForVersion(keyVersion), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  // Layout: iv(12) | tag(16) | ciphertext
  return { data: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]), keyVersion };
}

export function decryptBuffer(data: Buffer, keyVersion: number): Buffer {
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const decipher = createDecipheriv("aes-256-gcm", keyForVersion(keyVersion), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
}

export function encryptField(plain: string): string {
  const { data, keyVersion } = encryptBuffer(Buffer.from(plain, "utf8"));
  return `v${keyVersion}.${data.toString("base64url")}`;
}

export function decryptField(stored: string): string {
  const match = /^v(\d+)\.([A-Za-z0-9_-]+)$/.exec(stored);
  if (!match) throw new Error("Malformed encrypted field");
  return decryptBuffer(Buffer.from(match[2], "base64url"), Number(match[1])).toString("utf8");
}

/** Deterministic keyed hash for lookups/dedupe of sensitive values (e.g. Aadhaar). */
export function lookupHash(value: string): string {
  return createHmac("sha256", keyFromEnv("DATA_HMAC_KEY")).update(value.normalize("NFKC").replace(/\s+/g, "")).digest("hex");
}

/** Non-reversible hash for IPs and visitor ids stored for rate limiting/analytics. */
export function hashIdentifier(value: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is not set");
  return createHmac("sha256", secret).update(value).digest("hex").slice(0, 32);
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Display mask: keeps the last `visible` characters. "123412341234" → "XXXX-XXXX-1234". */
export function maskTail(value: string, visible = 4): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length <= visible) return "X".repeat(digits.length);
  const masked = "X".repeat(digits.length - visible) + digits.slice(-visible);
  return masked.replace(/(.{4})(?=.)/g, "$1-");
}
