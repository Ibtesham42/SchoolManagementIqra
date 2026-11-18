import { getAuthContext } from "@/lib/auth/context";
import { AppError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { exportErrorCode, EXPORT_MESSAGES } from "@/lib/http/export-errors";
import { assertSameOrigin, readBodyWithLimit } from "@/lib/http/upload";
import { enforce, RULES } from "@/lib/rate-limit";
import { exportStudentsSchema } from "@/modules/students/students.schemas";
import { exportStudentRows } from "@/modules/students/students.service";

export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 4096;
const FIELDS = { session: "academicSessionId", class: "classId", section: "sectionId", status: "status", q: "q" } as const;

/**
 * POST /api/v1/students/export — CSV of the student directory with the current filters (design §5.1).
 * POST (not GET) so the same-origin check applies: a cross-site page can't make a signed-in user's
 * browser run an audited personal-data export. Order: origin → session → rate limit → small form body →
 * Zod → service (export.run + student.read scope + admission.read ALL, ≤ 5,000 rows, audited).
 * Browser form posts that fail are redirected to the directory with a fixed status code.
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
    // Capped read with a short deadline (the Content-Length check above is not trusted on its own).
    const form = new URLSearchParams(new TextDecoder().decode(await readBodyWithLimit(request.body, MAX_FORM_BYTES, { timeoutMs: 10_000 })));
    const raw = Object.fromEntries(Object.entries(FIELDS).flatMap(([from, to]) => {
      const v = form.get(from);
      return v ? [[to, v]] : [];
    }));
    const parsed = exportStudentsSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError("Invalid export filters.");
    const { csv } = await exportStudentRows(ctx, parsed.data);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="students-${date}.csv"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const code = exportErrorCode(e);
    if (code === "failed") console.error("student export failed", e instanceof Error ? e.name : "unknown");
    if (html) return new Response(null, { status: 303, headers: { Location: code === "signed_out" ? "/login" : `/erp/students?export=${code}` } });
    const status = e instanceof AppError ? e.status : 500;
    return Response.json({ error: { code, message: EXPORT_MESSAGES[code] } }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
