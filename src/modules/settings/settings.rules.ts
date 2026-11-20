import { ConflictError, ValidationError } from "@/lib/errors";
import { validateFormat } from "@/lib/sequence";

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

/**
 * Phase 5 (FC12): fee number formats. Pure — unit tested. Exactly one {SEQ}/{SEQ:n} (lib/sequence) and only these
 * tokens: receipts {CODE} {YYYY} {YY} (a receipt can pay several sessions, so no {SESSION}); invoices also {SESSION}.
 * Never {CLASS}. A rendered number (5-digit counter, longest session name) must fit the 40-character columns.
 */
export type FeeNumberKind = "feeReceipt" | "feeInvoice";
const FEE_TOKENS: Record<FeeNumberKind, readonly string[]> = { feeReceipt: ["CODE", "YYYY", "YY"], feeInvoice: ["CODE", "YYYY", "YY", "SESSION"] };

export function feeFormatProblem(kind: FeeNumberKind, format: string, sample: { code: string | null; longestSession: string }): string | null {
  if (!/^[A-Za-z0-9{}:/._ -]+$/.test(format)) return "Use letters, digits, / - . _ and the tokens in braces.";
  const seq = (format.match(/\{SEQ(?::\d+)?\}/g) ?? []).length;
  if (seq !== 1) return "Use exactly one {SEQ} or {SEQ:n} (for example {SEQ:5}).";
  const width = Number(/\{SEQ:(\d+)\}/.exec(format)?.[1] ?? "1");
  if (width > 8) return "Pad the number to at most 8 digits ({SEQ:8}).";
  // Review 5A-M2 L1: only {SEQ} may carry a width; everything else is a bare token, exactly as lib/sequence renders.
  const TOKEN = /\{(?:([A-Z]+)|SEQ:\d+)\}/g;
  const tokens = [...format.matchAll(TOKEN)].map((m) => m[1]).filter((t): t is string => t !== undefined && t !== "SEQ");
  const bad = tokens.find((t) => !FEE_TOKENS[kind].includes(t));
  if (bad) return `{${bad}} can't be used here. Allowed: ${FEE_TOKENS[kind].map((t) => `{${t}}`).join(" ")} and {SEQ}.`;
  const rest = format.replace(TOKEN, "");
  if (rest.includes("{") || rest.includes("}")) return "Check the braces: tokens look like {SEQ:5}; only {SEQ} takes a number.";
  if (validateFormat(format) !== null) return "Check the tokens: only {CODE} {YYYY} {YY} {SESSION} and one {SEQ} are understood.";
  if (tokens.includes("CODE") && !sample.code) return "Set the school's short code first, or leave out {CODE}.";
  const rendered = format
    .replace(/\{CODE\}/g, sample.code ?? "")
    .replace(/\{YYYY\}/g, "2026")
    .replace(/\{YY\}/g, "26")
    .replace(/\{SESSION\}/g, sample.longestSession)
    .replace(/\{SEQ(?::\d+)?\}/, "9".repeat(Math.max(width, 7)));
  if (rendered.length > 40) return "Numbers made with this format would be longer than 40 characters.";
  return null;
}
