import { ConflictError, ValidationError } from "@/lib/errors";
import { formatSequence, sequenceKey, validateFormat, type FormatTokens } from "@/lib/sequence";

/**
 * Pure Phase 3A HR rules (no I/O — unit tested). Design: docs/PHASE_3_PLAN.md §3a (H1–H14), ADR-036,
 * docs/PHASE_3A_M1_SCHEMA_PROPOSAL.md §9 (Unicode-safe master-data names).
 */

// ───────────────────────────── Department / designation names (§9) ─────────────────────────────

/** Master-data codes: ASCII identifiers, the same shape the database CHECK enforces. */
export const MASTER_CODE_RE = /^[A-Z0-9]+(-[A-Z0-9]+)*$/;
export const MASTER_NAME_MAX = 80;
export const MASTER_CODE_MAX = 20;

const JOINERS = /[‌‍]/u; // ZWNJ, ZWJ — shape Indic conjuncts; meaningful only between letters
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
/** Letters and combining marks of any script, digits, space, . , & ( ) / ' - and the two joiners. */
const NAME_CHARS = /^[\p{L}\p{M}\p{Nd}][\p{L}\p{M}\p{Nd} .,&()/'\-‌‍]*$/u;

/**
 * Cleans a department/designation name, keeping the original spelling (any script):
 * NFC; zero-width space and BOM removed; every run of Unicode whitespace (incl. no-break space) → one space;
 * trimmed; ZWJ/ZWNJ kept only between two letters/marks (anywhere else they are invisible noise).
 */
export function cleanMasterName(raw: string): string {
  const chars = [...raw.normalize("NFC").replace(/[​﻿]/gu, "")];
  // Joiners first, then the whitespace rule: removing a stray joiner next to a space must not leave a double or
  // trailing space (the database CHECK requires single spaces and no edge spaces — security review L1).
  const kept = chars.filter((c, i) => !JOINERS.test(c) || (i > 0 && i < chars.length - 1 && LETTER_OR_MARK.test(chars[i - 1]) && LETTER_OR_MARK.test(chars[i + 1])));
  return kept.join("").replace(/\s+/gu, " ").trim();
}

/** Null if the cleaned name is acceptable, otherwise a user-facing message. */
export function masterNameProblem(name: string): string | null {
  if (name === "") return "Enter the name.";
  if ([...name].length > MASTER_NAME_MAX) return `Use at most ${MASTER_NAME_MAX} characters.`;
  if (!NAME_CHARS.test(name)) return "Use letters (any language), digits, spaces and . , & ( ) / ' - — starting with a letter or digit.";
  if ([...masterNameKeyOf(name)].length > MASTER_NAME_MAX) return `Use at most ${MASTER_NAME_MAX} characters.`;
  return null;
}

/**
 * Case-insensitive uniqueness key: NFKC → locale-independent Unicode lower case → NFKC → whitespace rule.
 * Composed and decomposed spellings collide (क़ / क + nukta, Khasi ï / i + diaeresis), "Ïing" and "ïing"
 * collide, full-width Latin folds to normal width; Devanagari has no case. ZWJ/ZWNJ are kept, so names that
 * differ only by a joiner stay distinct (the joiner changes the rendered spelling — proposal §9 default).
 */
export function masterNameKeyOf(name: string): string {
  return name.normalize("NFKC").toLowerCase().normalize("NFKC").replace(/\s+/gu, " ").trim();
}

// ───────────────────────────── Employee code (H3) ─────────────────────────────

export const DEFAULT_EMPLOYEE_CODE_FORMAT = "EMP-{YYYY}-{SEQ:4}";
export const EMPLOYEE_CODE_SEQUENCE = "employee_code";

export interface EmployeeCodePlan {
  format: string;
  key: string;
  tokens: FormatTokens;
}

/**
 * H3: `{YYYY}`/`{YY}` = the JOINING year; `{CODE}` = the school short code. `{SESSION}`/`{CLASS}` mean nothing
 * for staff and are refused, as is any invalid configured format (never silently replaced — a Super Admin
 * fixes Settings). The counter key includes the year, so numbering restarts per joining year.
 */
export function planEmployeeCode(input: { configuredFormat: string | null; joiningDate: Date; schoolCode: string | null }): EmployeeCodePlan {
  const format = input.configuredFormat ?? DEFAULT_EMPLOYEE_CODE_FORMAT;
  const problem = validateFormat(format) ?? (/\{(SESSION|CLASS)\}/.test(format) ? "{SESSION} and {CLASS} can't be used for employee IDs" : null);
  if (problem) throw new ConflictError(`The employee ID format in Settings is invalid (${problem}). Ask a Super Admin to fix it.`);
  if (format.includes("{CODE}") && !input.schoolCode) throw new ConflictError("Set the school short code in Settings before registering employees.");
  const tokens: FormatTokens = { code: input.schoolCode ?? undefined, year: input.joiningDate.getUTCFullYear() };
  return { format, key: sequenceKey(EMPLOYEE_CODE_SEQUENCE, format, tokens), tokens };
}

export function renderEmployeeCode(plan: EmployeeCodePlan, seq: number): string {
  return formatSequence(plan.format, seq, plan.tokens);
}

// ───────────────────────────── Dates (§9, database CHECKs) ─────────────────────────────

export const EARLIEST_DOB = "1940-01-01";
/** Joining dates may be entered up to this many days ahead (an offer accepted for next term). */
export const JOINING_MAX_DAYS_AHEAD = 90;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** All dates are school-local ISO dates ("YYYY-MM-DD"); `today` is today in the school's time zone. */
export function assertEmployeeDates(input: { dob: string; joiningDate: string; confirmationDate?: string | null }, today: string): void {
  const problems: { path: string; message: string }[] = [];
  if (input.dob < EARLIEST_DOB) problems.push({ path: "dob", message: "Check the date of birth." });
  if (input.dob >= input.joiningDate) problems.push({ path: "dob", message: "The date of birth must be before the joining date." });
  if (input.joiningDate > addDaysIso(today, JOINING_MAX_DAYS_AHEAD)) problems.push({ path: "joiningDate", message: `The joining date can be at most ${JOINING_MAX_DAYS_AHEAD} days from today.` });
  if (input.confirmationDate && input.confirmationDate < input.joiningDate) problems.push({ path: "confirmationDate", message: "The confirmation date can't be before the joining date." });
  if (problems.length) throw new ValidationError("Please correct the highlighted fields.", problems);
}

// ───────────────────────────── Status and labels ─────────────────────────────

export const STAFF_TYPES = ["TEACHING", "NON_TEACHING"] as const;
export const APPOINTMENT_TYPES = ["PERMANENT", "PROBATION", "CONTRACT", "PART_TIME", "GUEST"] as const;
export const EMPLOYMENT_STATUSES = ["ACTIVE", "ON_LEAVE", "RESIGNED", "TERMINATED", "RETIRED"] as const;
export type StaffType = (typeof STAFF_TYPES)[number];
export type AppointmentType = (typeof APPOINTMENT_TYPES)[number];
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const STAFF_TYPE_LABEL: Record<StaffType, string> = { TEACHING: "Teaching", NON_TEACHING: "Non-teaching" };
export const APPOINTMENT_TYPE_LABEL: Record<AppointmentType, string> = {
  PERMANENT: "Permanent",
  PROBATION: "Probation",
  CONTRACT: "Contract",
  PART_TIME: "Part-time",
  GUEST: "Guest",
};
export const EMPLOYMENT_STATUS_LABEL: Record<EmploymentStatus, string> = {
  ACTIVE: "Active",
  ON_LEAVE: "On leave",
  RESIGNED: "Resigned",
  TERMINATED: "Terminated",
  RETIRED: "Retired",
};
/** H10: new reporting lines may point only at someone still working at the school. */
export const REPORTABLE_STATUSES: readonly EmploymentStatus[] = ["ACTIVE", "ON_LEAVE"];

/** Changed keys only (shallow, JSON-comparable values). */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {};
  const a: Partial<T> = {};
  for (const k of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a };
}

/**
 * H6 personal tier: values never written to the audit log (field names only, "[REDACTED]" values) and never
 * shown without `employee.personal.read`. Names are directory data but are also kept out of audit rows
 * (Phase 2B convention: audit entries carry ids, codes and field names — not people's names).
 */
export const PERSONAL_FIELDS = ["dob", "gender", "personalPhone", "personalEmail", "address", "emergencyContact"] as const;
export const NAME_FIELDS = ["firstName", "middleName", "lastName"] as const;
export const EMPLOYMENT_TERMS = ["appointmentType", "joiningDate", "confirmationDate", "leavingDate", "leavingReason"] as const;

export function redactForAudit<T extends Record<string, unknown>>(values: Partial<T>): Record<string, unknown> {
  // Employment terms (appointment type, joining/confirmation dates) are personal tier too (H6; security review L3):
  // they stay in the permission-guarded service history, not in audit rows.
  const hidden = new Set<string>([...PERSONAL_FIELDS, ...NAME_FIELDS, ...EMPLOYMENT_TERMS, "workPhone", "workEmail"]);
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, hidden.has(k) ? "[REDACTED]" : v]));
}

// ───────────────────────────── Lifecycle (M4a — H10, H11, H12) ─────────────────────────────

export const STATUS_ACTIONS = ["RESIGN", "TERMINATE", "RETIRE", "START_LEAVE", "END_LEAVE", "REJOIN"] as const;
export type StatusAction = (typeof STATUS_ACTIONS)[number];
export type ServiceEventType =
  | "JOINED"
  | "CONFIRMED"
  | "DEPARTMENT_CHANGED"
  | "DESIGNATION_CHANGED"
  | "APPOINTMENT_TYPE_CHANGED"
  | "REPORTING_CHANGED"
  | "TRANSFERRED"
  | "STATUS_CHANGED"
  | "RESIGNED"
  | "TERMINATED"
  | "RETIRED"
  | "REJOINED";

export const STATUS_ACTION_LABEL: Record<StatusAction, string> = {
  RESIGN: "Resigned",
  TERMINATE: "Terminated",
  RETIRE: "Retired",
  START_LEAVE: "Long-term leave starts",
  END_LEAVE: "Back from long-term leave",
  REJOIN: "Rejoined",
};
export const SERVICE_EVENT_LABEL: Record<ServiceEventType, string> = {
  JOINED: "Joined",
  CONFIRMED: "Confirmed",
  DEPARTMENT_CHANGED: "Department changed",
  DESIGNATION_CHANGED: "Designation changed",
  APPOINTMENT_TYPE_CHANGED: "Appointment type changed",
  REPORTING_CHANGED: "Reporting line changed",
  TRANSFERRED: "Transferred",
  STATUS_CHANGED: "Status changed",
  RESIGNED: "Resigned",
  TERMINATED: "Terminated",
  RETIRED: "Retired",
  REJOINED: "Rejoined",
};

const LEAVER: readonly EmploymentStatus[] = ["RESIGNED", "TERMINATED", "RETIRED"];
export const isLeaverStatus = (s: EmploymentStatus) => LEAVER.includes(s);

/**
 * H11 status machine. Leaving (resign/terminate/retire) from ACTIVE or ON_LEAVE sets a leaving date and reason;
 * REJOIN brings a leaver back to ACTIVE with the same employee code (the leaving details stay in the history);
 * ON_LEAVE is informational until Phase 3B (long-term leave).
 */
export function planStatusChange(current: EmploymentStatus, action: StatusAction): { next: EmploymentStatus; event: ServiceEventType; leaving: boolean; rejoining: boolean } {
  const refuse = (msg: string): never => {
    throw new ConflictError(msg);
  };
  switch (action) {
    case "RESIGN":
    case "TERMINATE":
    case "RETIRE": {
      if (isLeaverStatus(current)) refuse("This employee has already left. Record a rejoining first.");
      const next = ({ RESIGN: "RESIGNED", TERMINATE: "TERMINATED", RETIRE: "RETIRED" } as const)[action];
      return { next, event: next, leaving: true, rejoining: false };
    }
    case "START_LEAVE":
      if (current !== "ACTIVE") refuse("Only an active employee can start long-term leave.");
      return { next: "ON_LEAVE", event: "STATUS_CHANGED", leaving: false, rejoining: false };
    case "END_LEAVE":
      if (current !== "ON_LEAVE") refuse("This employee is not on long-term leave.");
      return { next: "ACTIVE", event: "STATUS_CHANGED", leaving: false, rejoining: false };
    case "REJOIN":
      if (!isLeaverStatus(current)) refuse("Only an employee who has left can rejoin.");
      return { next: "ACTIVE", event: "REJOINED", leaving: false, rejoining: true };
  }
}

/**
 * Effective dates (school-local ISO): never before joining. Leaving and status changes happen today or earlier
 * (§9 "leaving ≤ today"); a rejoining is on or after the recorded leaving date; employment changes may be
 * entered up to JOINING_MAX_DAYS_AHEAD ahead (planned transfers).
 */
export function assertEffectiveDate(kind: "status" | "employment" | "rejoin", input: { effectiveDate: string; joiningDate: string; leavingDate?: string | null }, today: string): void {
  const problem = (message: string) => new ValidationError("Please correct the highlighted fields.", [{ path: "effectiveDate", message }]);
  if (input.effectiveDate < input.joiningDate) throw problem("The date can't be before the joining date.");
  if (kind === "employment" && input.effectiveDate > addDaysIso(today, JOINING_MAX_DAYS_AHEAD)) throw problem(`The date can be at most ${JOINING_MAX_DAYS_AHEAD} days from today.`);
  if (kind !== "employment" && input.effectiveDate > today) throw problem("The date can't be in the future.");
  if (kind === "rejoin" && input.leavingDate && input.effectiveDate < input.leavingDate) throw problem("Rejoining can't be before the leaving date.");
}

/**
 * H10: would making `managerId` the manager of `employeeId` create a reporting cycle (including self-reporting)?
 * `reportsTo` maps every employee id to its current manager id (or null). Walks up from the new manager.
 */
export function createsReportingCycle(employeeId: string, managerId: string, reportsTo: ReadonlyMap<string, string | null>): boolean {
  const seen = new Set<string>();
  for (let cur: string | null | undefined = managerId; cur; cur = reportsTo.get(cur)) {
    if (cur === employeeId) return true;
    if (seen.has(cur)) return true; // existing cycle (shouldn't exist): refuse rather than loop
    seen.add(cur);
  }
  return false;
}

// ───────────────────────────── Directory export (M5) ─────────────────────────────

export const STAFF_EXPORT_MAX_ROWS = 5000;
/** Directory fields only — the export never contains personal-tier data (data minimisation, H6). */
export const STAFF_EXPORT_HEADER = ["Employee ID", "Name", "Staff type", "Designation", "Department", "Status", "Work phone", "Work email"] as const;
export function assertStaffExportSize(count: number): void {
  if (count > STAFF_EXPORT_MAX_ROWS) throw new ConflictError(`Too many staff match for one export (limit ${STAFF_EXPORT_MAX_ROWS}). Narrow the filters.`);
}
