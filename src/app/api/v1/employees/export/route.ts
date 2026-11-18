import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { exportErrorCode, STAFF_EXPORT_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { exportEmployeesSchema } from "@/modules/hr/hr.schemas";
import { exportEmployeeRows } from "@/modules/hr/employees.service";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 4096;
const FIELDS = { q: "q", type: "staffType", department: "departmentId", designation: "designationId", status: "status", appointment: "appointmentType" } as const;

/**
 * POST /api/v1/employees/export — CSV of the staff directory (directory fields only) with the current filters
 * (Phase 3A M5). Same pattern as the student export: POST so the same-origin check applies; origin → session →
 * rate limit → small form body → Zod → service (export.run + employee.read ALL, ≤ 5,000 rows, audited).
 * Failed browser form posts are redirected to the directory with a fixed status code.
 */
export async function POST(request: Request) {
  const html = (request.headers.get("accept") ?? "").includes("text/html");
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
    const raw = Object.fromEntries(
      Object.entries(FIELDS).flatMap(([from, to]) => {
        const v = form.get(from);
        return v ? [[to, v]] : [];
      }),
    );
    const parsed = exportEmployeesSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Invalid export filters.");
    const { csv } = await exportEmployeeRows(ctx, parsed.data);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="staff-${date}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = exportErrorCode(e);
    if (code === "failed") console.error("staff export failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `/erp/hr/employees?export=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: STAFF_EXPORT_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
