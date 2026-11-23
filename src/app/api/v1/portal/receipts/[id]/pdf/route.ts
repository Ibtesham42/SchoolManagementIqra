import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError, RateLimitedError } from "@/lib/errors";
import { jsonError } from "@/lib/http/file-response";
import { pdfResponse } from "@/lib/pdf/render";
import { enforce, RULES } from "@/lib/rate-limit";
import { renderPortalReceiptPdf } from "@/modules/fees/fees.portal";

export const dynamic = "force-dynamic";
const PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/v1/portal/receipts/{id}/pdf — the PARENT COPY of a fee receipt (Phase 6B-M3, P13) for a parent account that may
 * see the child's fees. Cross-site refused (Sec-Fetch-Site); rate limit `portal-pdf`; missing, not yours and not
 * permitted are the SAME 404; never counted as a print; audited as a view; attachment `receipt.pdf`, `private, no-store`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return jsonError(403, "FORBIDDEN", "Open the receipt from the portal.");
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Receipt not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    await enforce(RULES.portalPdf, ctx.userId);
    const { pdf, fileName } = await renderPortalReceiptPdf(ctx, id);
    return pdfResponse(pdf, fileName, "attachment");
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Receipt not found.");
    if (e instanceof RateLimitedError) return jsonError(429, "RATE_LIMITED", "Too many downloads. Please wait a few minutes.");
    console.error("portal receipt pdf failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "The receipt could not be generated.");
  }
}
