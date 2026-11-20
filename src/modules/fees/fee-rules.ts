/**
 * Pure billing rules (PHASE_5_PLAN.md FC4, FC25). No I/O — unit tested.
 * - Only PLANNED / ACTIVE sessions generate invoices (arrears of any session can still be collected).
 * - ACTIVE enrollments: installments due on or after `enrolledOn` (a joiner isn't billed for earlier ones).
 * - LEFT enrollments: the same, but only installments due on or before `leftOn`; their unpaid invoices stay as dues.
 * - PROMOTED / DETAINED enrollments of the old session are never billed again.
 * - Items: NEW_ADMISSION only for a student admitted in this session, EXISTING only for everyone else, ALL for all.
 */
export type EnrollmentStatus = "ACTIVE" | "PROMOTED" | "DETAINED" | "LEFT";
export type SessionStatus = "PLANNED" | "ACTIVE" | "CLOSED";
export type AppliesTo = "ALL" | "NEW_ADMISSION" | "EXISTING";

export interface BillableEnrollment {
  status: EnrollmentStatus;
  enrolledOn: string;
  leftOn: string | null;
  /** The student was admitted in this session (Student.admittedSessionId = the session). */
  newAdmission: boolean;
}

export interface InstallmentRef {
  id: string;
  dueOn: string;
}

export function sessionGeneratesInvoices(status: SessionStatus): boolean {
  return status === "PLANNED" || status === "ACTIVE";
}

export function billableInstallments<T extends InstallmentRef>(e: BillableEnrollment, installments: readonly T[]): T[] {
  if (e.status === "PROMOTED" || e.status === "DETAINED") return [];
  return installments.filter((i) => i.dueOn >= e.enrolledOn && (e.status !== "LEFT" || (e.leftOn !== null && i.dueOn <= e.leftOn)));
}

export function itemApplies(appliesTo: AppliesTo, newAdmission: boolean): boolean {
  return appliesTo === "ALL" || (appliesTo === "NEW_ADMISSION" ? newAdmission : !newAdmission);
}

/**
 * Non-cash references (FC10): trimmed, inner spaces removed, upper-cased; 4–40 of A–Z 0–9 / - _ . starting with a
 * letter or digit (review 5A L6: never a spreadsheet formula character). Same rule as the database CHECK.
 */
export function normalizeReference(raw: string): string | null {
  const v = raw.normalize("NFKC").trim().replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9][A-Z0-9/_.-]{3,39}$/.test(v) ? v : null;
}

/** Cheque bank names (review 5A M4): trimmed, single spaces, upper case — part of the cheque's uniqueness key. */
export function normalizeBankName(raw: string): string | null {
  const v = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toUpperCase();
  return v.length >= 2 && v.length <= 80 && /^[A-Z0-9][A-Z0-9 .&()-]*$/.test(v) ? v : null;
}

export type PaymentMethod = "CASH" | "UPI" | "BANK_TRANSFER" | "CHEQUE" | "CARD";
export const needsReference = (m: PaymentMethod) => m !== "CASH";
