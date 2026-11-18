/**
 * Pure text helpers for people's names and phone numbers, shared by admissions and student records
 * (no I/O — unit tested). Lives in `students` because `admissions` depends on `students`, never the
 * other way round; `admissions.rules` re-exports these for its existing callers.
 */

/** Trim, collapse whitespace, Unicode NFC (so "é" typed two ways compares equal). */
export function cleanText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

/** "Ananya", null, "Das" → "Ananya Das". */
export function fullNameOf(first: string, middle?: string | null, last?: string | null): string {
  return [first, middle, last].map((p) => (p ? cleanText(p) : "")).filter(Boolean).join(" ");
}

/** Duplicate detection, search and roll-number ordering key: NFC, trimmed, single spaces, lower case. */
export function normalizeName(fullName: string): string {
  return cleanText(fullName).toLowerCase();
}

/**
 * Indian phone numbers to 10 digits: strips spaces, hyphens, brackets, a leading +91 / 91 (when 12 digits) / 0.
 * Returns null unless the result is exactly 10 digits not starting with 0 — mobiles start 6–9, landlines
 * with their STD code start 1–8 (Delhi "011 2345 6789" → "1123456789"); same rule as the school phone schema.
 */
export function normalizePhone(raw: string): string | null {
  let d = raw.replace(/[\s\-().]/g, "");
  if (d.startsWith("+91")) d = d.slice(3);
  else if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[1-9]\d{9}$/.test(d) ? d : null;
}
