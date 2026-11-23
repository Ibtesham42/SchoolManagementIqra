/**
 * Calendar-month helpers on school-local ISO dates ("YYYY-MM-DD") and months ("YYYY-MM"). Pure — unit tested.
 * Used by the portal month views (Phase 6B-M1).
 */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const monthOf = (isoDate: string) => isoDate.slice(0, 7);

/** First and last day of a month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The requested month if valid and inside [start, end]; otherwise the month of `fallback` clamped into the range. */
export function clampMonth(requested: string | undefined, start: string, end: string, fallback: string): string {
  const first = monthOf(start);
  const last = monthOf(end);
  const pick = requested && MONTH_RE.test(requested) ? requested : monthOf(fallback);
  return pick < first ? first : pick > last ? last : pick;
}

/** 0 = Sunday … 6 = Saturday, for an ISO date (UTC, no time-zone shift). */
export const weekdayOf = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();
