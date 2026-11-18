import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Pure academic-session rules (no I/O — unit tested). Services apply them inside transactions.
 *
 * Model: a session is PLANNED (future), ACTIVE (in use — several may be active while one year
 * winds down and the next starts) or CLOSED (read-only, final). Exactly one session is *current*
 * (SchoolSetting.currentAcademicSessionId): the default for new admissions and reports. The current
 * session must be ACTIVE and can't be closed while current. Sessions may not overlap in time.
 */
export type SessionStatus = "PLANNED" | "ACTIVE" | "CLOSED";

export interface SessionLike {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  status: SessionStatus;
}

const DAY = 24 * 60 * 60 * 1000;
export const MAX_SESSION_DAYS = 548; // ~18 months

/** Parses "YYYY-MM-DD" as a calendar date at UTC midnight (matches Postgres DATE). */
export function parseDateOnly(value: string): Date {
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError("Use a valid date.", [{ path: "startDate", message: "Invalid date." }]);
  }
  return d;
}

/** "2026-27" must start in 2026 and end in 2027; end after start; at most ~18 months. */
export function assertSessionShape(name: string, start: Date, end: Date): void {
  const [y1, y2] = name.split("-");
  const startYear = Number(y1);
  // "2026-27" → 2027; "2099-00" → 2100 (two-digit end year in the same or next century).
  let endYear = Math.floor(startYear / 100) * 100 + Number(y2);
  if (endYear <= startYear) endYear += 100;
  if (end.getTime() <= start.getTime()) {
    throw new ValidationError("The end date must be after the start date.", [{ path: "endDate", message: "Must be after the start date." }]);
  }
  if ((end.getTime() - start.getTime()) / DAY > MAX_SESSION_DAYS) {
    throw new ValidationError("A session can't be longer than 18 months.", [{ path: "endDate", message: "Too long." }]);
  }
  if (endYear !== startYear + 1) {
    throw new ValidationError(`"${name}" must name consecutive years, e.g. ${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}.`, [
      { path: "name", message: "Years must be consecutive." },
    ]);
  }
  if (start.getUTCFullYear() !== startYear || end.getUTCFullYear() !== endYear) {
    throw new ValidationError(`Dates must fall in ${startYear}–${endYear} to match "${name}".`, [{ path: "startDate", message: "Dates don't match the name." }]);
  }
}

/** Inclusive date ranges overlap? */
export function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() <= bEnd.getTime() && bStart.getTime() <= aEnd.getTime();
}

export function assertNoOverlap(candidate: { id?: string; startDate: Date; endDate: Date }, existing: SessionLike[]): void {
  const clash = existing.find((s) => s.id !== candidate.id && rangesOverlap(candidate.startDate, candidate.endDate, s.startDate, s.endDate));
  if (clash) throw new ConflictError(`These dates overlap with session ${clash.name}.`);
}

const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  PLANNED: ["ACTIVE", "CLOSED"],
  ACTIVE: ["CLOSED"],
  CLOSED: [],
};

export function assertStatusTransition(session: SessionLike, to: SessionStatus, currentSessionId: string | null): void {
  if (!TRANSITIONS[session.status].includes(to)) {
    throw new ConflictError(`A ${session.status.toLowerCase()} session can't be changed to ${to.toLowerCase()}.`);
  }
  if (to === "CLOSED" && session.id === currentSessionId) {
    throw new ConflictError("Choose another current session before closing this one.");
  }
}

export function assertCanBeCurrent(session: SessionLike): void {
  if (session.status !== "ACTIVE") throw new ConflictError("Only an active session can be the current session.");
}

/** Dates and name are editable only while PLANNED (later they anchor enrollments and records). */
export function assertEditable(session: SessionLike): void {
  if (session.status !== "PLANNED") throw new ConflictError("Only planned sessions can be edited.");
}
