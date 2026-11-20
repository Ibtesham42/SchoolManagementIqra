import Decimal from "decimal.js";

/**
 * Money helpers (CLAUDE.md rule 7; Phase 5 plan §2). Pure — unit tested. Amounts are rupees with 2 decimals, held as
 * decimal.js values and exchanged as canonical strings ("1250.50"). Rounding is half-up to 2 dp, only at the points a
 * caller defines (a line amount, a final total) — never implicitly.
 */
export const Money = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export type MoneyValue = InstanceType<typeof Money>;

/** Amount as typed: up to 10 rupee digits, optional 1–2 paise digits. No sign, no grouping, no exponent. */
export const MONEY_RE = /^\d{1,10}(\.\d{1,2})?$/;
/** Decimal(12,2) holds at most 9,999,999,999.99. */
export const MONEY_MAX = new Money("9999999999.99");

export const round2 = (d: Decimal.Value): MoneyValue => new Money(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * Parses an amount with at most 2 decimals — a string or a Prisma Decimal, never a JS number (review 5A L1: floats
 * like 0.1 + 0.2 and 3-decimal strings would make allocations stop adding up). Throws on anything else.
 */
export function toMoney(v: string | { toString(): string }): MoneyValue {
  if (typeof v === "number") throw new RangeError("money must not be a JS number");
  const s = (typeof v === "string" ? v : v.toString()).trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new RangeError("not a money amount (at most 2 decimals)");
  const d = new Money(s);
  if (d.abs().gt(MONEY_MAX)) throw new RangeError("money amount out of range");
  return d;
}

/** A rate such as a percent: 0–999 with up to 4 decimals; never a JS number. */
export function toRate(v: string | { toString(): string }): MoneyValue {
  if (typeof v === "number") throw new RangeError("rate must not be a JS number");
  const s = (typeof v === "string" ? v : v.toString()).trim();
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(s)) throw new RangeError("not a rate");
  return new Money(s);
}

/** "1250.5" → "1250.50" (2 dp, half-up). */
export const moneyString = (d: Decimal.Value): string => round2(d).toFixed(2);

export function sumMoney(values: readonly Decimal.Value[]): MoneyValue {
  return values.reduce<MoneyValue>((acc, v) => acc.plus(v), new Money(0));
}

/** Display with Indian digit grouping: 1234567.5 → "12,34,567.50" (no currency sign). */
export function formatIndianMoney(d: Decimal.Value): string {
  const [int, frac] = round2(d).abs().toFixed(2).split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${new Money(d).isNeg() ? "-" : ""}${rest ? `${rest},${last3}` : last3}.${frac}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? below100(r) : ""].filter(Boolean).join(" ");
}

/** Indian system words for a whole number ≥ 0 (crore, lakh, thousand, hundred). */
export function wordsIndian(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("whole number expected");
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  let rest = n % 10_000_000;
  if (crore) parts.push(`${wordsIndian(crore)} Crore`);
  const lakh = Math.floor(rest / 100_000);
  rest %= 100_000;
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  const thousand = Math.floor(rest / 1000);
  rest %= 1000;
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  return parts.join(" ");
}

/** Receipt wording: 1250.50 → "Rupees One Thousand Two Hundred Fifty and Paise Fifty Only". */
export function amountInWordsIndian(d: Decimal.Value): string {
  const v = round2(d);
  if (v.isNeg()) throw new RangeError("negative amount");
  const [int, frac] = v.toFixed(2).split(".");
  const paise = Number(frac);
  return `Rupees ${wordsIndian(Number(int))}${paise ? ` and Paise ${below100(paise)}` : ""} Only`;
}
