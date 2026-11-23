import { getAuthContext } from "@/lib/auth/context";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError } from "@/lib/errors";
import { jsonError } from "@/lib/http/file-response";
import { pdfResponse } from "@/lib/pdf/render";
import { enforce, RULES } from "@/lib/rate-limit";
import { renderPortalReportCardPdf } from "@/modules/academic/results.portal";

export const dynamic = "force-dynamic";
const PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/v1/portal/report-cards/{id}/pdf — the PARENT COPY of a published report card (Phase 6B-M2, P11), for a
 * parent / student account that may see the child. Cross-site requests refused (Sec-Fetch-Site); rate limit
 * `portal-pdf` (30 / 10 min / user); missing, not yours and not permitted are the SAME 404; attachment with a
 * non-identifying name, `private, no-store`; audited as a view; never counted as a print.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return jsonError(403, "FORBIDDEN", "Open the report card from the portal.");
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Report card not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    await enforce(RULES.portalPdf, ctx.userId);
    const { pdf, fileName } = await renderPortalReportCardPdf(ctx, id);
    return pdfResponse(pdf, fileName, "attachment");
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Report card not found.");
    if (e instanceof RateLimitedError) return jsonError(429, "RATE_LIMITED", "Too many downloads. Please wait a few minutes.");
    if (e instanceof ConflictError) return jsonError(409, "CONFLICT", e.message);
    console.error("portal report card pdf failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "The report card could not be generated.");
  }
}
