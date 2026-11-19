import { getAuthContext } from "@/lib/auth/context";
import { AppError } from "@/lib/errors";
import { pdfResponse } from "@/lib/pdf/render";
import { renderSlipPdf } from "@/modules/payroll/slips.service";
import { idField } from "@/modules/students/person.schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/payroll/slips/{id}/pdf — the salary slip PDF (Phase 3C P12): payroll readers any approved slip; staff
 * their own (salary.self.read SELF). Out of scope → 404. `private, no-store`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }, { status: 401 });
  const id = idField.safeParse((await params).id);
  if (!id.success) return Response.json({ error: { code: "NOT_FOUND", message: "Salary slip not found." } }, { status: 404 });
  try {
    const { pdf, fileName } = await renderSlipPdf(ctx, id.data);
    return pdfResponse(pdf, fileName);
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error("salary slip pdf failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: { code: "INTERNAL", message: "The slip could not be generated." } }, { status: 503 });
  }
}
