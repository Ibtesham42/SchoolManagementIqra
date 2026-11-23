import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { PORTAL_SLIP_MESSAGES, portalSlipErrorCode } from "@/lib/http/portal-slip-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { pdfResponse } from "@/lib/pdf/render";
import { enforce, RULES } from "@/lib/rate-limit";
import { guardianSlipSchema, sectionSlipsSchema } from "@/modules/students/family-accounts.schemas";
import { issueGuardianSlip, issueSectionSlips, renderActivationSlipsPdf } from "@/modules/students/family-accounts.service";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 2048;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * POST /api/v1/portal-accounts/slips — parent portal activation slips as a PDF (Phase 6A-M3, ADR-046).
 * `target=guardian` (studentId, guardianId, mode create | reset, optional username) or `target=section` (sectionId,
 * reissuePending). Same-origin POST → session → rate limit (`portal-slips`) → ≤ 2 KB urlencoded body → Zod → service
 * (`portal.account.manage` + `student.read` ALL; codes issued and audited in one transaction) → PDF rendered after
 * the commit. `private, no-store`, attachment, a non-identifying file name. Failed browser posts go back to the
 * page with a fixed code (`?slips=<code>`).
 */
export async function POST(request: Request) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  let back = "/erp/students";
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    const length = Number(request.headers.get("content-length") ?? "NaN");
    if (!(length <= MAX_FORM_BYTES) || !(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) throw new ValidationError("Invalid slip request.");
    const form = new URLSearchParams(new TextDecoder().decode(await readBodyWithLimit(request.body, MAX_FORM_BYTES, { timeoutMs: 10_000 })));
    const target = form.get("target");
    const studentId = form.get("studentId") ?? "";
    const sectionId = form.get("sectionId") ?? "";
    // The page to return to is built from validated ids only (never a URL taken from the request).
    if (target === "guardian" && ID_RE.test(studentId)) back = `/erp/students/${studentId}`;
    if (target === "section" && ID_RE.test(sectionId)) back = `/erp/students/portal-accounts?section=${sectionId}`;
    await enforce(RULES.portalSlips, ctx.userId);

    let slips;
    if (target === "guardian") {
      const parsed = guardianSlipSchema.safeParse({ studentId, guardianId: form.get("guardianId"), mode: form.get("mode"), username: form.get("username") ?? "" });
      if (!parsed.success) throw new ValidationError("Invalid slip request.", parsed.error.issues.some((i) => i.path[0] === "username") ? [{ path: "username", message: "Invalid username." }] : undefined);
      slips = await issueGuardianSlip(ctx, parsed.data);
    } else if (target === "section") {
      const parsed = sectionSlipsSchema.safeParse({ sectionId, reissuePending: form.get("reissuePending") === "on" });
      if (!parsed.success) throw new ValidationError("Invalid slip request.");
      slips = (await issueSectionSlips(ctx, parsed.data)).slips;
    } else {
      throw new ValidationError("Invalid slip request.");
    }
    if (slips.length === 0) {
      return html ? new Response(null, { status: 303, headers: { Location: `${back}${back.includes("?") ? "&" : "?"}slips=none` } }) : Response.json({ error: { code: "none", message: PORTAL_SLIP_MESSAGES.none } }, { status: 409 });
    }
    return pdfResponse(await renderActivationSlipsPdf(slips), "portal-activation-slips.pdf", "attachment");
  } catch (e) {
    const code = portalSlipErrorCode(e);
    if (code === "failed") console.error("portal slips failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `${back}${back.includes("?") ? "&" : "?"}slips=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: PORTAL_SLIP_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
