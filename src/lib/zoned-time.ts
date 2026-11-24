/**
 * School-local wall-clock times ↔ UTC instants (Phase 6C notices: "publish at 07:30" means 07:30 at the school,
 * whatever the server's zone). Pure; Intl only.
 */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Offset (ms) of `timeZone` from UTC at `instant`: local wall clock − UTC. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(instant));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * "YYYY-MM-DDTHH:mm" (an `<input type="datetime-local">` value) read as wall-clock time in `timeZone` → the UTC
 * instant, or null when the text isn't a real date-time. In a DST gap the later side wins (rare; India has none).
 */
export function localDateTimeToUtc(value: string, timeZone: string): Date | null {
  const m = LOCAL_DATE_TIME.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) return null;
  let t = wall - offsetAt(wall, timeZone);
  t = wall - offsetAt(t, timeZone); // second pass settles a guess that crossed an offset change
  return new Date(t);
}

/** The UTC instant as "YYYY-MM-DDTHH:mm" wall-clock time in `timeZone` (for a datetime-local input's value). */
export function utcToLocalDateTime(instant: Date, timeZone: string): string {
  const local = new Date(instant.getTime() + offsetAt(instant.getTime(), timeZone));
  return local.toISOString().slice(0, 16);
}

/** The instant a school-local date (YYYY-MM-DD) ends: midnight at the start of the NEXT day in `timeZone`. */
export function endOfLocalDay(date: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const next = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1));
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return null;
  return localDateTimeToUtc(`${next.toISOString().slice(0, 10)}T00:00`, timeZone);
}
