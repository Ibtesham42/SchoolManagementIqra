import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError, RateLimitedError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { enforce, RULES } from "@/lib/rate-limit";
import { readPortalNoticeAttachment } from "@/modules/notices/notices.portal";

export const dynamic = "force-dynamic";
const PATH_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * GET /api/v1/portal/notices/{id}/attachment — a notice attachment for a parent / student account whose child is in
 * the notice's audience now (Phase 6C-M1, P22). Cross-site refused; rate limit `portal-pdf`; missing / not yours / not permitted
 * are the SAME 404; owner-bound and audited by the file layer; `private, no-store`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return jsonError(403, "FORBIDDEN", "Open the attachment from the portal.");
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Attachment not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    await enforce(RULES.portalPdf, ctx.userId);
    return privateFileResponse(await readPortalNoticeAttachment(ctx, id));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Attachment not found.");
    if (e instanceof RateLimitedError) return jsonError(429, "RATE_LIMITED", "Too many downloads. Please wait a few minutes.");
    console.error("portal notice attachment failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Attachment unavailable.");
  }
}
