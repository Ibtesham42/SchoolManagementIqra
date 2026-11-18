import {
  AppError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitedError,
  RequestTimeoutError,
  ServiceBusyError,
  UnauthenticatedError,
  UnsupportedMediaTypeError,
  ValidationError,
} from "@/lib/errors";
import { isTransactionBusy } from "@/lib/db-errors";

/**
 * Upload outcomes as FIXED codes. A plain HTML form post is redirected back with `?upload=<code>` and the
 * page shows the matching fixed text — never text taken from the URL, so a crafted link can't put
 * arbitrary messages on the school's pages.
 */
export const UPLOAD_MESSAGES = {
  ok: "Document uploaded.",
  too_large: "The file is too large. The limit is 10 MB.",
  bad_type: "This file type isn't accepted. Use PDF, JPEG or PNG (photos: JPEG or PNG).",
  invalid: "The upload couldn't be accepted. Check the document type and the file, then try again.",
  photo_failed: "The photo couldn't be processed, so it was not saved. Use a clear JPEG or PNG image.",
  busy: "The system is busy. Please try again in a moment.",
  too_slow: "The upload took too long. Check the connection and try again.",
  rate_limited: "Too many uploads in a short time. Please wait a few minutes.",
  signed_out: "Please sign in again, then retry the upload.",
  forbidden: "You don't have permission to upload documents here, or the request didn't come from this site.",
  not_found: "That application wasn't found.",
  closed: "Documents can't be changed after the application has been decided.",
  failed: "The upload failed. Please try again.",
} as const;
export type UploadCode = keyof typeof UPLOAD_MESSAGES;

/** Same fixed codes for staff documents (Phase 3A M4b) — staff wording, never text from the URL. */
export const STAFF_UPLOAD_MESSAGES: Record<UploadCode, string> = {
  ...UPLOAD_MESSAGES,
  forbidden: "You don't have permission to upload staff documents, or the request didn't come from this site.",
  not_found: "That staff record wasn't found.",
  closed: "Documents can't be changed for this staff record.",
};

export function isUploadCode(v: unknown): v is UploadCode {
  return typeof v === "string" && Object.hasOwn(UPLOAD_MESSAGES, v);
}

export function uploadErrorCode(e: unknown): UploadCode {
  if (e instanceof PayloadTooLargeError) return "too_large";
  if (e instanceof RequestTimeoutError) return "too_slow";
  if (e instanceof UnsupportedMediaTypeError) return "invalid";
  if (e instanceof RateLimitedError) return "rate_limited";
  if (e instanceof ServiceBusyError || isTransactionBusy(e)) return "busy";
  if (e instanceof UnauthenticatedError) return "signed_out";
  if (e instanceof ForbiddenError) return "forbidden";
  if (e instanceof NotFoundError) return "not_found";
  if (e instanceof ValidationError) {
    if (/photo/i.test(e.message) && /process/i.test(e.message)) return "photo_failed";
    if (/type isn't accepted|must be a JPEG or PNG/i.test(e.message)) return "bad_type";
    if (/limit is/i.test(e.message)) return "too_large";
    return "invalid";
  }
  if (e instanceof AppError && e.code === "CONFLICT") return "closed";
  return "failed";
}

/** HTTP status for an upload/download error (busy → 503; unknown errors → 500, never details). */
export function errorStatus(e: unknown): number {
  if (isTransactionBusy(e)) return 503;
  return e instanceof AppError ? e.status : 500;
}
