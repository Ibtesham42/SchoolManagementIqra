import { randomInt } from "node:crypto";

// No look-alike characters (0/O, 1/l/I) — temporary passwords are often read aloud or copied by hand.
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Cryptographically random temporary password, grouped for readability: "aB3k-9xQp-Mw7r". ~70 bits. */
export function generateTemporaryPassword(groups = 3, groupLength = 4): string {
  const parts: string[] = [];
  for (let g = 0; g < groups; g++) {
    let s = "";
    for (let i = 0; i < groupLength; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    parts.push(s);
  }
  return parts.join("-");
}
