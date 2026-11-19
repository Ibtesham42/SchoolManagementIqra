import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { ATTENDANCE_EXPORT_MESSAGES, exportErrorCode } from "@/lib/http/export-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { payrollSummaryExportSchema } from "@/modules/hr/staff-attendance.schemas";
import { exportPayrollAttendanceSummary } from "@/modules/hr/staff-attendance.service";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 1024;

/**
 * POST /api/v1/staff-attendance/summary/export — CSV of the monthly attendance summary for payroll (Phase 3B M5).
 * Same pattern as the staff export: origin → session → rate limit → small form body → Zod → service (export.run +
 * summary access, ≤ 5,000 rows, audited). Failed browser form posts redirect to the summary with a fixed code.
 */
export async function POST(request: Request) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  let month = "";
  try {
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    await enforce(RULES.export, ctx.userId);
    const length = Number(request.headers.get("content-length") ?? "NaN");
    if (!(length <= MAX_FORM_BYTES) || !(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded")) {
      throw new ValidationError("Invalid export request.");
    }
    const form = new URLSearchParams(new TextDecoder().decode(await readBodyWithLimit(request.body, MAX_FORM_BYTES, { timeoutMs: 10_000 })));
    const parsed = payrollSummaryExportSchema.safeParse({ month: form.get("month") ?? "", departmentId: form.get("department") ?? "" });
    if (!parsed.success) throw new ValidationError("Invalid export filters.");
    month = parsed.data.month;
    const { csv } = await exportPayrollAttendanceSummary(ctx, parsed.data);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="staff-attendance-${month}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = exportErrorCode(e);
    if (code === "failed") console.error("attendance summary export failed", e instanceof Error ? e.name : "unknown");
    if (html) {
      // `month` is only ever a schema-validated YYYY-MM (or empty) — never other request text.
      const back = `/erp/staff-attendance/summary?${new URLSearchParams({ ...(month ? { month } : {}), export: code }).toString()}`;
      return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : back } });
    }
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: ATTENDANCE_EXPORT_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
