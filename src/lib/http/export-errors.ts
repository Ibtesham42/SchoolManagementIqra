import { ConflictError, ForbiddenError, PayloadTooLargeError, RateLimitedError, RequestTimeoutError, ServiceBusyError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { isTransactionBusy } from "@/lib/db-errors";

/**
 * Export outcomes as FIXED codes (same approach as uploads): a failed form post is redirected back with
 * `?export=<code>` and the page shows the matching fixed text — never text taken from the URL.
 */
export const EXPORT_MESSAGES = {
  too_many: "Too many students match for one export (limit 5,000). Narrow the filters and try again.",
  rate_limited: "Too many exports in a short time. Please wait a few minutes.",
  busy: "The system is busy. Please try again in a moment.",
  forbidden: "You don't have permission to export student data, or the request didn't come from this site.",
  invalid: "The export filters weren't valid. Reload the page and try again.",
  signed_out: "Please sign in again, then retry the export.",
  failed: "The export failed. Please try again.",
} as const;
export type ExportCode = keyof typeof EXPORT_MESSAGES;

export function isExportCode(v: unknown): v is ExportCode {
  return typeof v === "string" && Object.hasOwn(EXPORT_MESSAGES, v);
}

export function exportErrorCode(e: unknown): ExportCode {
  if (e instanceof RateLimitedError) return "rate_limited";
  if (e instanceof ServiceBusyError || isTransactionBusy(e)) return "busy";
  if (e instanceof UnauthenticatedError) return "signed_out";
  if (e instanceof ForbiddenError) return "forbidden";
  if (e instanceof ConflictError) return "too_many";
  if (e instanceof ValidationError || e instanceof PayloadTooLargeError || e instanceof RequestTimeoutError) return "invalid";
  return "failed";
}

/** Same fixed codes for the staff directory export (Phase 3A M5) — staff wording, never text from the URL. */
export const STAFF_EXPORT_MESSAGES: Record<ExportCode, string> = {
  ...EXPORT_MESSAGES,
  too_many: "Too many staff match for one export (limit 5,000). Narrow the filters and try again.",
  forbidden: "You don't have permission to export the staff directory, or the request didn't come from this site.",
};

/** Phase 3B M5: the monthly attendance summary export — same fixed codes, attendance wording. */
export const ATTENDANCE_EXPORT_MESSAGES: Record<ExportCode, string> = {
  ...EXPORT_MESSAGES,
  too_many: "Too many staff for one export (limit 5,000). Choose a department and try again.",
  forbidden: "You don't have permission to export the attendance summary, or the request didn't come from this site.",
};

/** Phase 3C-M6: payroll register export — same fixed codes, payroll wording. */
export const PAYROLL_EXPORT_MESSAGES: Record<ExportCode, string> = {
  ...EXPORT_MESSAGES,
  too_many: "This payroll has too many slips for one export.",
  forbidden: "You don't have permission to export payroll, or the request didn't come from this site.",
  invalid: "This payroll can't be exported yet (prepare it first).",
};

/** Phase 4C-M4: the marks import template (one marks sheet) — same fixed codes, marks wording. */
export const MARKS_TEMPLATE_MESSAGES: Record<ExportCode, string> = {
  ...EXPORT_MESSAGES,
  too_many: "This marks sheet can't be downloaded right now.",
  forbidden: "These marks can't be changed now, or the request didn't come from this site.",
  invalid: "The template request wasn't valid. Reload the page and try again.",
  rate_limited: "Too many downloads in a short time. Please wait a few minutes.",
};

/** Phase 5C-M1: fee report exports — same fixed codes, fee wording. */
export const FEE_REPORT_EXPORT_MESSAGES: Record<ExportCode, string> = {
  ...EXPORT_MESSAGES,
  too_many: "This report has more than 5,000 rows. Narrow the filters and try again.",
  forbidden: "You don't have permission to export fee reports, or the request didn't come from this site.",
  invalid: "The report filters weren't valid. Choose them again and retry.",
};
