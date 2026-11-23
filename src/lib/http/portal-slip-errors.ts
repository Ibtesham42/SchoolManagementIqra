import { ConflictError, ForbiddenError, NotFoundError, PayloadTooLargeError, RateLimitedError, RequestTimeoutError, ServiceBusyError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { isTransactionBusy } from "@/lib/db-errors";

/**
 * Phase 6A-M3 — outcomes of an activation-slip request as FIXED codes: a failed form post is redirected back with
 * `?slips=<code>` and the page shows the matching fixed text (never text from the URL).
 */
export const PORTAL_SLIP_MESSAGES = {
  username: "Choose a username for this account: the mobile number is missing or already used by another account.",
  exists: "This guardian already has a portal account. Use \"Print a new slip\" instead.",
  none: "Nothing to print: every primary guardian in this section already has an account, or needs a username (see the list).",
  blocked: "This guardian can't see any studying child in the portal (blocked, or no child is studying), so no slip was printed.",
  deactivated: "This portal account is deactivated. Reactivate it first.",
  not_found: "That student or guardian wasn't found. Reload the page and try again.",
  too_many: "This section is too large for one run. Issue slips from each student's profile.",
  rate_limited: "Too many slips in a short time. Please wait a few minutes.",
  busy: "The system is busy. Please try again in a moment.",
  forbidden: "You can't issue portal accounts, the portal role was changed (ask a Super Admin), or the request didn't come from this site.",
  invalid: "The request wasn't valid. Reload the page and try again.",
  signed_out: "Please sign in again, then retry.",
  failed: "The slips couldn't be printed. If accounts were created, print a new slip from the student's profile.",
} as const;
export type PortalSlipCode = keyof typeof PORTAL_SLIP_MESSAGES;

export const isPortalSlipCode = (v: unknown): v is PortalSlipCode => typeof v === "string" && Object.hasOwn(PORTAL_SLIP_MESSAGES, v);

export function portalSlipErrorCode(e: unknown): PortalSlipCode {
  if (e instanceof RateLimitedError) return "rate_limited";
  if (e instanceof ServiceBusyError || isTransactionBusy(e)) return "busy";
  if (e instanceof UnauthenticatedError) return "signed_out";
  if (e instanceof ForbiddenError) return "forbidden";
  if (e instanceof NotFoundError) return "not_found";
  if (e instanceof ConflictError) return /deactivated/i.test(e.message) ? "deactivated" : "exists";
  if (e instanceof ValidationError) {
    if (e.details?.some((f) => f.path === "username")) return "username";
    if (e.details?.some((f) => f.path === "guardianId")) return "blocked";
    return /more than \d+ students/.test(e.message) ? "too_many" : "invalid";
  }
  if (e instanceof PayloadTooLargeError || e instanceof RequestTimeoutError) return "invalid";
  return "failed";
}
