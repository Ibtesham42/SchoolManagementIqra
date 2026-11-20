import { z } from "zod";
import { getAuthContext } from "@/lib/auth/context";
import { AppError, NotFoundError, UnauthenticatedError } from "@/lib/errors";
import { exportErrorCode, MARKS_TEMPLATE_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { marksImportTemplate } from "@/modules/academic/marks-import.service";
import { sheetRefSchema } from "@/modules/academic/marks.schemas";

export const dynamic = "force-dynamic";

const formSchema = sheetRefSchema.extend({ format: z.enum(["csv", "xlsx"]) }).strict();

/**
 * POST /api/v1/academic/marks/template — the marks import template for one sheet (Phase 4C-M4, AC19), CSV or XLSX.
 * Same-origin POST → session → rate limit (own marks-template bucket) → service (whoever may save the sheet now; anything else
 * 404 / 403; formula-safe cells; audited). Failed browser posts redirect back to the sheet with a fixed code.
 */
export async function POST(request: Request) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  let back = "/erp/academic/marks";
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    await enforce(RULES.marksTemplate, ctx.userId);
    const fd = await request.formData().catch(() => null);
    const parsed = formSchema.safeParse({ examSubjectId: fd?.get("examSubjectId"), sectionId: fd?.get("sectionId"), format: fd?.get("format") });
    if (!parsed.success) throw new NotFoundError("Marks sheet not found.");
    const { format, ...ref } = parsed.data;
    back = `/erp/academic/marks/sheet?es=${encodeURIComponent(ref.examSubjectId)}&section=${encodeURIComponent(ref.sectionId)}`;
    const { body, fileName, contentType } = await marksImportTemplate(ctx, ref, format);
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
    if (code === "failed") console.error("marks template failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `${back}${back.includes("?") ? "&" : "?"}template=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: MARKS_TEMPLATE_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
