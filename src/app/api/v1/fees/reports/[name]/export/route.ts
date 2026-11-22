import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { exportErrorCode, FEE_REPORT_EXPORT_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { reportQuerySchema } from "@/modules/fees/reports.schemas";
import { exportFeeReport } from "@/modules/fees/reports.service";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 2048;
const FIELDS = ["academicSessionId", "from", "to", "groupBy", "by", "minDays"] as const;

/**
 * POST /api/v1/fees/reports/{name}/export — a fee report as CSV (Phase 5C-M1, FC20). Same pattern as the other
 * exports: same-origin check → session → rate limit (`RULES.export`) → small form body → Zod → service (`fee.report`
 * ALL + `export.run`, ≤ 5,000 rows, formula-safe, audited). Failed browser posts go back to the reports page with a
 * fixed code (never text from the URL).
 */
export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    await enforce(RULES.export, ctx.userId);
    const length = Number(request.headers.get("content-length") ?? "NaN");
    if (!(length <= MAX_FORM_BYTES) || !(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) throw new ValidationError("Invalid export request.");
    const form = new URLSearchParams(new TextDecoder().decode(await readBodyWithLimit(request.body, MAX_FORM_BYTES, { timeoutMs: 10_000 })));
    const raw: Record<string, string> = { report: (await params).name };
    for (const f of FIELDS) {
      const v = form.get(f);
      if (v) raw[f] = v;
    }
    const parsed = reportQuerySchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Invalid report filters.");
    const { csv, fileName } = await exportFeeReport(ctx, parsed.data);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = exportErrorCode(e);
    if (code === "failed") console.error("fee report export failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `/erp/fees/reports?export=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: FEE_REPORT_EXPORT_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
