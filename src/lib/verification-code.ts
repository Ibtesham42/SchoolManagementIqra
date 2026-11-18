import { createHmac, randomBytes } from "node:crypto";
import { keyFromEnv } from "@/lib/crypto";

/**
 * Verification codes printed on issued documents (ID cards, certificates…).
 *
 * - 80 bits from the OS CSPRNG, written as 16 Crockford base32 characters ("7K3M-Q9TX-…"):
 *   no I/L/O/U, so codes survive being read aloud or typed from paper.
 * - Only an HMAC-SHA256 of the code is stored, keyed with DOCUMENT_VERIFICATION_KEY — a key used
 *   for nothing else (not DATA_HMAC_KEY). A database leak does not reveal codes, and codes can't be
 *   brute-forced offline without the key.
 * - Keys are versioned (GeneratedDocument.verificationKeyVersion). Rotation: move the current key
 *   to DOCUMENT_VERIFICATION_KEY_V<old version>, set a new DOCUMENT_VERIFICATION_KEY and increment
 *   DOCUMENT_VERIFICATION_KEY_VERSION. Documents issued earlier keep verifying as long as their
 *   old key stays configured (a code can't be re-hashed: the raw code is never stored).
 * - Public lookups must also be rate limited (80 bits is far beyond online guessing).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const CODE_LENGTH = 16;
const CODE_BYTES = 10; // 80 bits = 16 × 5 bits
const HASH_DOMAIN = "document-verification";
const OLD_KEY_PREFIX = "DOCUMENT_VERIFICATION_KEY_V";

export function generateVerificationCode(random: (n: number) => Buffer = randomBytes): string {
  const bytes = random(CODE_BYTES);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1; // keep only unread bits (prevents overflow)
  }
  return out;
}

/** Display form: groups of four, e.g. "7K3M-Q9TX-2B4R-HJ6N". */
export function formatVerificationCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/**
 * Canonical form of user input, or null if it can't be a code: case-insensitive, ignores spaces and
 * dashes, and maps the Crockford look-alikes O→0 and I/L→1.
 */
export function normalizeVerificationCode(input: string): string | null {
  if (input.length > 40) return null;
  const c = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

/** Version used for newly issued documents. */
export function currentVerificationKeyVersion(): number {
  const v = Number(process.env.DOCUMENT_VERIFICATION_KEY_VERSION ?? 1);
  if (!Number.isInteger(v) || v < 1 || v > MAX_KEY_VERSION) throw new Error("DOCUMENT_VERIFICATION_KEY_VERSION must be an integer from 1 to 32767");
  return v;
}

function keyForVersion(version: number): Buffer {
  return version === currentVerificationKeyVersion() ? keyFromEnv("DOCUMENT_VERIFICATION_KEY") : keyFromEnv(`${OLD_KEY_PREFIX}${version}`);
}

const MAX_KEY_VERSION = 32767; // generated_document.verification_key_version is SMALLINT

/**
 * Version of a rotated-out key variable, or null unless the name is exactly
 * DOCUMENT_VERIFICATION_KEY_V<1–32767> with no leading zeros — the only spelling keyForVersion()
 * ever reads. (A lenient parse let "…_V01" claim version 1 and then fail to load "…_V1",
 * breaking every verification.) Start-up validation rejects names that start with the prefix but
 * aren't canonical, so a typo is reported instead of silently ignored.
 */
export function parseRotatedKeyName(name: string): number | null {
  const m = /^DOCUMENT_VERIFICATION_KEY_V([1-9]\d{0,4})$/.exec(name);
  if (!m) return null;
  const v = Number(m[1]);
  return v <= MAX_KEY_VERSION ? v : null;
}

/** Versions whose key is configured: the current one plus every canonical DOCUMENT_VERIFICATION_KEY_V<n>. */
export function configuredVerificationKeyVersions(): number[] {
  const current = currentVerificationKeyVersion();
  const old = Object.keys(process.env)
    .filter((k) => process.env[k])
    .map(parseRotatedKeyName)
    .filter((v): v is number => v !== null && v !== current);
  return [current, ...[...new Set(old)].sort((a, b) => b - a)];
}

/** The only value ever stored (GeneratedDocument.verificationCodeHash). Input must be normalized. */
export function hashVerificationCode(normalized: string, version = currentVerificationKeyVersion()): string {
  return createHmac("sha256", keyForVersion(version)).update(`${HASH_DOMAIN}\u0000${normalized}`).digest("hex");
}

/** Hash under every configured key version, for lookup after rotations. */
export function verificationHashCandidates(normalized: string): { version: number; hash: string }[] {
  return configuredVerificationKeyVersions().map((version) => ({ version, hash: hashVerificationCode(normalized, version) }));
}
