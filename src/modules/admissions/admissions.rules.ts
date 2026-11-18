import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";

/**
 * Pure admission rules (no I/O — unit tested). Services apply them inside transactions with freshly
 * locked rows. Design: docs/PHASE_2B_STUDENTS_DESIGN.md §2.2 (state machine), §2.5 (duplicates), §1a (D5).
 */
export type AdmissionStatus = "DRAFT" | "SUBMITTED" | "UNDER_REVIEW" | "APPROVED" | "REJECTED";
export type GuardianRelation = "FATHER" | "MOTHER" | "GUARDIAN" | "OTHER";

export const STATUS_LABEL: Record<AdmissionStatus, string> = {
  DRAFT: "Draft",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
};

/** D5: application number format when SchoolSetting.idFormats.applicationNo is not set. */
export const DEFAULT_APPLICATION_NO_FORMAT = "APP-{SESSION}-{SEQ:4}";
export const APPLICATION_NO_SEQUENCE = "application_no";

// Names and phone numbers: shared with student records (moved to students/person-fields).
export { cleanText, fullNameOf, normalizeName, normalizePhone } from "@/modules/students/person-fields";

// ───────────────────────────── State machine ─────────────────────────────

export type AdmissionAction = "edit" | "delete" | "submit" | "startReview" | "setSection" | "returnToDraft" | "reject" | "approve" | "manageDocuments";

const ALLOWED_FROM: Record<AdmissionAction, AdmissionStatus[]> = {
  edit: ["DRAFT"],
  delete: ["DRAFT"],
  submit: ["DRAFT"],
  startReview: ["SUBMITTED"],
  setSection: ["SUBMITTED", "UNDER_REVIEW"],
  returnToDraft: ["SUBMITTED", "UNDER_REVIEW"],
  reject: ["SUBMITTED", "UNDER_REVIEW"],
  approve: ["SUBMITTED", "UNDER_REVIEW"],
  // Documents often arrive late (e.g. the transfer certificate): allowed until the decision.
  manageDocuments: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"],
};

const ACTION_TEXT: Record<AdmissionAction, string> = {
  edit: "edited",
  delete: "deleted",
  submit: "submitted",
  startReview: "put under review",
  setSection: "assigned a section",
  returnToDraft: "returned to draft",
  reject: "rejected",
  approve: "approved",
  manageDocuments: "given new documents",
};

export function canDo(action: AdmissionAction, status: AdmissionStatus): boolean {
  return ALLOWED_FROM[action].includes(status);
}

export function assertCanDo(action: AdmissionAction, status: AdmissionStatus): void {
  if (!canDo(action, status)) {
    throw new ConflictError(`A ${STATUS_LABEL[status].toLowerCase()} application can't be ${ACTION_TEXT[action]}.`);
  }
}

/**
 * Drafts are hard-deleted only while they have never been submitted: once an application number exists,
 * the number and its history stay (a returned application is edited and resubmitted, or rejected).
 */
export function assertDeletable(status: AdmissionStatus, applicationNo: string | null): void {
  assertCanDo("delete", status);
  if (applicationNo) throw new ConflictError("This application has already been submitted once. Reject it instead of deleting it.");
}

export function assertVersion(current: number, submitted: number): void {
  if (current !== submitted) throw new ConflictError("This application was changed by someone else. Reload the page and try again.");
}

/** Applications are accepted for PLANNED or ACTIVE sessions; CLOSED sessions are read-only. */
export function assertSessionOpenForAdmissions(status: "PLANNED" | "ACTIVE" | "CLOSED"): void {
  if (status === "CLOSED") throw new ConflictError("This academic session is closed. Choose another session.");
}

/** The child must be born before the session starts (and from 1990 — DB CHECK). */
export function assertDobForSession(dob: Date, sessionStart: Date): void {
  if (dob.getTime() >= sessionStart.getTime()) {
    throw new ValidationError("The date of birth must be before the session starts.", [{ path: "dob", message: "Must be before the session starts." }]);
  }
}

// ───────────────────────────── Submission completeness ─────────────────────────────

export interface CompletenessFacts {
  guardians: { relation: GuardianRelation; isPrimary: boolean }[];
  address: unknown;
}

/** What is still missing before submission (field paths for the form; empty = ready). */
export function missingForSubmission(f: CompletenessFacts): { step: number; message: string }[] {
  const missing: { step: number; message: string }[] = [];
  if (f.guardians.length === 0) missing.push({ step: 2, message: "Add at least one parent or guardian." });
  else if (f.guardians.filter((g) => g.isPrimary).length !== 1) missing.push({ step: 2, message: "Choose one primary contact." });
  if (!f.address) missing.push({ step: 3, message: "Enter the home address." });
  return missing;
}

/** D10: required documents not yet uploaded (a warning — never blocks approval). */
export function missingDocuments(required: readonly string[], present: readonly string[]): string[] {
  const have = new Set(present);
  return required.filter((t) => !have.has(t));
}

// ───────────────────────────── Duplicate detection (design §2.5) ─────────────────────────────

export interface DuplicateCandidate {
  kind: "student" | "application";
  id: string;
  fullNameNormalized: string;
  dob: Date;
  guardianPhones: string[];
}

export interface DuplicateMatch {
  kind: "student" | "application";
  id: string;
  /** "strong": same name + date of birth + a shared guardian phone; "possible": same name + date of birth. */
  strength: "strong" | "possible";
}

/** Same normalised name and date of birth = possible duplicate; plus a shared guardian phone = strong. */
export function findDuplicates(applicant: { id?: string; fullNameNormalized: string; dob: Date; guardianPhones: string[] }, candidates: DuplicateCandidate[]): DuplicateMatch[] {
  const phones = new Set(applicant.guardianPhones);
  return candidates
    .filter((c) => !(c.kind === "application" && c.id === applicant.id))
    .filter((c) => c.fullNameNormalized === applicant.fullNameNormalized && c.dob.getTime() === applicant.dob.getTime())
    .map((c) => ({ kind: c.kind, id: c.id, strength: c.guardianPhones.some((p) => phones.has(p)) ? ("strong" as const) : ("possible" as const) }))
    .sort((a, b) => (a.strength === b.strength ? 0 : a.strength === "strong" ? -1 : 1));
}

// ───────────────────────────── Audit helpers ─────────────────────────────

/**
 * Names of fields whose values changed. Application audit entries record WHICH fields changed, not the
 * personal values (names, phones, addresses) — the application row itself holds the current values.
 */
export function changedFieldNames(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return Object.keys(after).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}

// ───────────────────────────── Separation of duties (S-14) ─────────────────────────────

export const SELF_APPROVAL_MESSAGE = "You created this application, so it must be approved by another School Admin or the Principal.";

/**
 * S-14 (owner decision, 2026-11-10): the person who created an application may not approve it — another
 * School Admin or the Principal must (four eyes on every registration). Applies to every approver, Super
 * Admin included. A creator whose account was deleted (createdById null) blocks no one.
 */
export function assertNotSelfApproval(createdById: string | null, approverId: string): void {
  if (createdById !== null && createdById === approverId) throw new ForbiddenError(SELF_APPROVAL_MESSAGE);
}
