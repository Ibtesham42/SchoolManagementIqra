/**
 * Date formatting for the UI in the SCHOOL's time zone, never the server's (a UTC server would
 * otherwise show Indian schools times 5½ hours off). Pages pass the configured zone from
 * `getSchoolTimezone()` (modules/settings/settings.public); the default matches
 * SchoolSetting.timezone's default.
 */
export const DEFAULT_SCHOOL_TIMEZONE = "Asia/Kolkata";

/** An instant (timestamptz), shown as a calendar date in the school's time zone. */
export function formatDate(d: Date, timeZone = DEFAULT_SCHOOL_TIMEZONE): string {
  return d.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone });
}

export function formatDateTime(d: Date, timeZone = DEFAULT_SCHOOL_TIMEZONE): string {
  return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone });
}

/**
 * A date-only value (Postgres DATE → JS Date at UTC midnight), e.g. session start/end, date of birth.
 * Always formatted in UTC: shifting it into a time zone behind UTC would show the previous day.
 */
export function formatDateOnly(d: Date): string {
  return d.toLocaleDateString("en-IN", { dateStyle: "medium", timeZone: "UTC" });
}

/** Date-only value as "YYYY-MM-DD" for <input type="date">. */
export function toDateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar date in the school's time zone as "YYYY-MM-DD" (for date inputs such as the admission date). */
export function todayInTimeZone(timeZone = DEFAULT_SCHOOL_TIMEZONE, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
