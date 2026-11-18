import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { formatSequence, sequenceKey, validateFormat, type FormatTokens } from "@/lib/sequence";

/**
 * Pure student-registration rules (no I/O — unit tested). Design docs/PHASE_2B_STUDENTS_DESIGN.md §2.3;
 * owner decisions D1 (approval = registration), D4 ({YYYY} = session start year), D9 (explicit guardian links).
 */

/** Defaults when SchoolSetting.idFormats does not set them (seed placeholders use the same). */
export const DEFAULT_STUDENT_ID_FORMAT = "{CODE}-{YYYY}-{SEQ:4}";
export const DEFAULT_ADMISSION_NO_FORMAT = "ADM-{YYYY}-{SEQ:4}";
export const STUDENT_ID_SEQUENCE = "student_id";
export const ADMISSION_NO_SEQUENCE = "admission_no";

export interface IdPlan {
  format: string;
  key: string;
  tokens: FormatTokens;
}

/**
 * Formats and counter keys for the two permanent identifiers. D4: {YYYY}/{YY} are the START year of the
 * admission's academic session (2026-27 → 2026), whatever the calendar date of approval. An invalid
 * configured format is refused (never silently replaced): a Super Admin must fix Settings.
 */
export function planPermanentIds(input: { studentIdFormat: string | null; admissionNoFormat: string | null; schoolCode: string; sessionName: string; sessionStart: Date; classCode: string }) {
  const tokens: FormatTokens = { code: input.schoolCode, year: input.sessionStart.getUTCFullYear(), session: input.sessionName, className: input.classCode };
  const plan = (base: string, configured: string | null, fallback: string): IdPlan => {
    const format = configured ?? fallback;
    const problem = validateFormat(format);
    if (problem) throw new ConflictError(`The ${base === STUDENT_ID_SEQUENCE ? "student ID" : "admission number"} format in Settings is invalid (${problem}). Ask a Super Admin to fix it.`);
    return { format, key: sequenceKey(base, format, tokens), tokens };
  };
  return {
    studentId: plan(STUDENT_ID_SEQUENCE, input.studentIdFormat, DEFAULT_STUDENT_ID_FORMAT),
    admissionNo: plan(ADMISSION_NO_SEQUENCE, input.admissionNoFormat, DEFAULT_ADMISSION_NO_FORMAT),
  };
}

export function renderId(plan: IdPlan, seq: number): string {
  return formatSequence(plan.format, seq, plan.tokens);
}

/** Admission date: inside the session, not before the date of birth. School-local DATE (UTC midnight). */
export function assertAdmissionDate(admissionDate: Date, session: { startDate: Date; endDate: Date }, dob: Date): void {
  if (admissionDate.getTime() < session.startDate.getTime() || admissionDate.getTime() > session.endDate.getTime()) {
    throw new ValidationError("The admission date must fall within the academic session.", [{ path: "admissionDate", message: "Outside the session." }]);
  }
  if (admissionDate.getTime() <= dob.getTime()) {
    throw new ValidationError("The admission date must be after the date of birth.", [{ path: "admissionDate", message: "Before the date of birth." }]);
  }
}

/** Capacity is a hard limit at enrollment time (checked under the section's row lock). */
export function assertSeatAvailable(activeEnrollments: number, capacity: number, sectionLabel: string): void {
  if (activeEnrollments >= capacity) {
    throw new ConflictError(`Section ${sectionLabel} is full (${activeEnrollments}/${capacity}). Choose another section or raise its capacity first.`);
  }
}

// ───────────────────────────── Guardian linking (D9) ─────────────────────────────

export interface ApplicantGuardian {
  id: string;
  phone: string;
}
export interface ExistingGuardian {
  id: string;
  phone: string;
  deleted: boolean;
}

/**
 * Validates the reviewer's explicit choices: each applicant guardian maps to null (create a new Guardian)
 * or to an EXISTING guardian. A link is accepted only if that guardian exists, is not deleted and has the
 * SAME phone number — the reviewer was shown exactly those matches, so a typo or a crafted request can't
 * attach a child to an unrelated family. Two applicant guardians can't both link to the same person.
 * Unknown applicant-guardian ids are refused; missing entries mean "create new" (never an automatic link).
 */
export function resolveGuardianLinks(applicants: ApplicantGuardian[], links: Record<string, string | null>, existing: ExistingGuardian[]): Map<string, string | null> {
  const known = new Set(applicants.map((a) => a.id));
  for (const id of Object.keys(links)) {
    if (!known.has(id)) throw new ValidationError("A guardian choice doesn't belong to this application. Reload the page.", [{ path: "guardianLinks", message: "Unknown guardian." }]);
  }
  const byId = new Map(existing.map((g) => [g.id, g]));
  const used = new Set<string>();
  const out = new Map<string, string | null>();
  for (const a of applicants) {
    const target = links[a.id] ?? null;
    if (target === null) {
      out.set(a.id, null);
      continue;
    }
    const g = byId.get(target);
    if (!g || g.deleted) throw new ValidationError("The selected existing guardian no longer exists. Reload the page.", [{ path: "guardianLinks", message: "Guardian not found." }]);
    if (g.phone !== a.phone) throw new ValidationError("An existing guardian can only be linked when the phone number matches.", [{ path: "guardianLinks", message: "Phone numbers differ." }]);
    if (used.has(target)) throw new ValidationError("Two guardians of this application can't be linked to the same person.", [{ path: "guardianLinks", message: "Linked twice." }]);
    used.add(target);
    out.set(a.id, target);
  }
  return out;
}

/** Duplicate matches require a written override reason from the approver (design §2.5). */
export function assertDuplicateOverride(matchCount: number, override: string | null): void {
  if (matchCount > 0 && !override) {
    throw new ConflictError(`This child may already be registered or applying (${matchCount} possible match${matchCount === 1 ? "" : "es"}). Give a reason to approve anyway.`);
  }
}

// ───────────────────────────── Student records (S7) ─────────────────────────────

export type StudentStatus = "ACTIVE" | "TRANSFERRED" | "GRADUATED" | "WITHDRAWN";
export const STUDENT_STATUSES = ["ACTIVE", "TRANSFERRED", "GRADUATED", "WITHDRAWN"] as const;
export const LEAVING_STATUSES = ["TRANSFERRED", "WITHDRAWN", "GRADUATED"] as const;
export type LeavingStatus = (typeof LEAVING_STATUSES)[number];

export const STUDENT_STATUS_LABEL: Record<StudentStatus, string> = {
  ACTIVE: "Active",
  TRANSFERRED: "Transferred",
  GRADUATED: "Graduated",
  WITHDRAWN: "Withdrawn",
};

/**
 * Status changes (`student.transfer`): only an ACTIVE student can leave (transfer, withdrawal, graduation).
 * Re-admission of a student who left needs a section and a capacity check, so it is not offered here
 * (a future slice adds it with its own enrollment); the change is refused rather than half-done.
 */
export function assertStatusChange(from: StudentStatus, to: StudentStatus): asserts to is LeavingStatus {
  if (!(LEAVING_STATUSES as readonly string[]).includes(to)) {
    throw new ValidationError("Choose transferred, withdrawn or graduated.", [{ path: "toStatus", message: "Not a leaving status." }]);
  }
  if (from !== "ACTIVE") {
    throw new ConflictError(`This student is already ${STUDENT_STATUS_LABEL[from].toLowerCase()}. Re-admission isn't available yet.`);
  }
}

/**
 * The leaving date is a school-local date: not before the admission date or the start of the enrollment
 * being closed, and not in the future (today in the school's time zone, "YYYY-MM-DD").
 */
export function assertLeavingDate(effective: Date, earliest: Date, todayIso: string): void {
  if (effective.getTime() < earliest.getTime()) {
    throw new ValidationError("The date can't be before the student joined this class.", [{ path: "effectiveDate", message: "Before the enrollment started." }]);
  }
  if (effective.toISOString().slice(0, 10) > todayIso) {
    throw new ValidationError("The date can't be in the future.", [{ path: "effectiveDate", message: "In the future." }]);
  }
}

/** The date of birth must stay before the admission date (an edit could otherwise break the history). */
export function assertDobBeforeAdmission(dob: Date, admissionDate: Date): void {
  if (dob.getTime() >= admissionDate.getTime()) {
    throw new ValidationError("The date of birth must be before the admission date.", [{ path: "dob", message: "After the admission date." }]);
  }
}

/**
 * Field-level edit rules (design §4.2). A holder of `student.update` at ALL scope may edit identity and
 * contact fields; at ASSIGNED scope (class teacher) only contact fields. Permanent IDs (student ID,
 * admission number) are never editable by anyone — the input schemas don't even accept them.
 */
export const STUDENT_CONTACT_FIELDS = ["phone", "email", "address"] as const;
export const STUDENT_IDENTITY_FIELDS = ["firstName", "middleName", "lastName", "dob", "gender"] as const;
export const GUARDIAN_CONTACT_FIELDS = ["phone", "altPhone", "email"] as const;
export const GUARDIAN_IDENTITY_FIELDS = ["name", "occupation"] as const;

export function editableStudentFields(updateScope: "ALL" | "ASSIGNED"): readonly string[] {
  return updateScope === "ALL" ? [...STUDENT_IDENTITY_FIELDS, ...STUDENT_CONTACT_FIELDS] : STUDENT_CONTACT_FIELDS;
}
export function editableGuardianFields(updateScope: "ALL" | "ASSIGNED"): readonly string[] {
  return updateScope === "ALL" ? [...GUARDIAN_IDENTITY_FIELDS, ...GUARDIAN_CONTACT_FIELDS] : GUARDIAN_CONTACT_FIELDS;
}

/** Refuses a change to any field outside the caller's allowance (checked on the CHANGED fields only). */
export function assertFieldsEditable(changed: readonly string[], allowed: readonly string[]): void {
  const blocked = changed.filter((f) => !allowed.includes(f));
  if (blocked.length) throw new ForbiddenError("You can only change contact details for the students of your section.");
}

/** Names of the fields whose value differs (JSON comparison, so addresses compare by content). */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => after[k] !== undefined && JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

export function pick<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]])) as Partial<T>;
}

/** Export limit: a larger export must be narrowed by filters (never silently truncated). */
export const EXPORT_MAX_ROWS = 5000;
export function assertExportSize(count: number): void {
  if (count > EXPORT_MAX_ROWS) {
    throw new ConflictError(`More than ${EXPORT_MAX_ROWS} students match — the export limit is ${EXPORT_MAX_ROWS}. Narrow the filters (session, class or section) and try again.`);
  }
}

/**
 * Export audit content: the filters WITHOUT the free-text search, which is often a child's name — only
 * whether a search was used and its length are recorded.
 */
export function exportFilterAudit(input: { academicSessionId?: string; classId?: string; sectionId?: string; status?: string; q?: string }) {
  const { q, ...rest } = input;
  return { ...rest, ...(q ? { search: { used: true, length: q.length } } : {}) };
}
