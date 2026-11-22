import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { AppError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { exportErrorCode, OPENING_TEMPLATE_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { openingTemplate } from "@/modules/fees/opening-balances.service";
import { openingRefSchema } from "@/modules/fees/opening.schemas";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 2048;
const formSchema = openingRefSchema.extend({ format: z.enum(["csv", "xlsx"]) }).strict();

/**
 * POST /api/v1/fees/opening-balances/template — the previous-dues template for one class of a session (Phase 5C-M3,
 * FC19), CSV or XLSX. Same-origin POST → session → rate limit (`fee-template`) → service (`fee.structure.manage` ALL;
 * formula-safe; audited). Failed browser posts go back to the import page with a fixed code.
 */
export async function POST(request: Request) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    await enforce(RULES.feeTemplate, ctx.userId);
    // Review 5C-M3 L2: a small urlencoded body only, read with a hard limit (no unbounded formData()).
    const length = Number(request.headers.get("content-length") ?? "NaN");
    if (!(length <= MAX_FORM_BYTES) || !(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) throw new ValidationError("Invalid template request.");
    const form = new URLSearchParams(new TextDecoder().decode(await readBodyWithLimit(request.body, MAX_FORM_BYTES, { timeoutMs: 10_000 })));
    const parsed = formSchema.safeParse({ academicSessionId: form.get("academicSessionId"), classId: form.get("classId"), format: form.get("format") });
    if (!parsed.success) throw new NotFoundError("Class not found.");
    const { format, ...ref } = parsed.data;
    const { body, fileName, contentType } = await openingTemplate(ctx, ref, format);
    return new Response(body as unknown as BodyInit, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = e instanceof NotFoundError ? "invalid" : exportErrorCode(e);
    if (code === "failed") console.error("opening template failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `/erp/fees/opening-balances?template=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: OPENING_TEMPLATE_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
