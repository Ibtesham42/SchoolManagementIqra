import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError } from "@/lib/errors";
import { exportErrorCode, PAYROLL_EXPORT_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { exportRunRegister } from "@/modules/payroll/reports.service";
import { idField } from "@/modules/students/person.schemas";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/payroll/runs/{id}/export — the payroll register as CSV (Phase 3C-M6). Same pattern as the other exports:
 * same-origin POST → session → rate limit → service (payroll.read + export.run, ≤ 5,000 rows, formula-safe cells,
 * audited). No PAN / bank details. Failed browser posts redirect back to the run with a fixed code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  const parsed = idField.safeParse((await params).id);
  const back = parsed.success ? `/erp/payroll/runs/${parsed.data}` : "/erp/payroll/runs";
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    await enforce(RULES.export, ctx.userId);
    if (!parsed.success) return Response.json({ error: { code: "NOT_FOUND", message: "Payroll run not found." } }, { status: 404 });
    const { csv, month } = await exportRunRegister(ctx, parsed.data);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payroll-${month}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = exportErrorCode(e);
    if (code === "failed") console.error("payroll export failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `${back}?export=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: PAYROLL_EXPORT_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
