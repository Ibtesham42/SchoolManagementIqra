import { randomInt } from "node:crypto";
import { sha256Hex } from "@/lib/crypto";

/**
 * Phase 6A-M3 (ADR-046) — portal activation codes, printed on the office's activation slip. Pure — unit tested.
 *
 * - 12 characters from a capital-letters-and-digits alphabet without look-alikes (no 0/O, 1/I/L), shown as
 *   "ABCD-EFGH-JKMN": ~59 bits from the OS CSPRNG. Parents type it from paper on a phone, so case never matters and
 *   spaces / dashes are ignored.
 * - Only a SHA-256 of the normalised code is stored (domain-separated); never logged, audited or put in a URL query.
 * - Valid 21 days, single use, only the newest code of an account works, void after 5 wrong dates of birth entered
 *   with the right code. Wrong codes count nowhere (review 6A-M3a M1) — guessing is bounded by the per-IP limit.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ACTIVATION_CODE_LENGTH = 12;
export const ACTIVATION_TTL_DAYS = 21;
export const MAX_ACTIVATION_ATTEMPTS = 5;

export function generateActivationCode(pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < ACTIVATION_CODE_LENGTH; i++) s += ALPHABET[pick(ALPHABET.length)];
  return s;
}

/** "abcd efgh-jkmn" → "ABCDEFGHJKMN"; anything that can't be a code → "". */
export function normalizeActivationCode(raw: string): string {
  const s = raw.normalize("NFKC").replace(/[\s-]/g, "").toUpperCase();
  return s.length === ACTIVATION_CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : "";
}

export const formatActivationCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

export const hashActivationCode = (normalized: string) => sha256Hex(`portal-activation:${normalized}`);

/** A code row works only while unused and unexpired. */
export function isActivationUsable(row: { usedAt: Date | null; expiresAt: Date } | null | undefined, now = new Date()): boolean {
  return !!row && row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}

/**
 * The password hash of a portal account that was never activated, or was reset by the office. It is not an Argon2
 * hash, so no password ever verifies against it; login treats it exactly like a wrong password.
 */
export const UNUSABLE_PASSWORD_HASH = "!portal-not-activated";
export const isUsablePasswordHash = (hash: string) => hash.startsWith("$argon2");
