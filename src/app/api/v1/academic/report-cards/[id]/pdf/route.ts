import { getAuthContext } from "@/lib/auth/context";
import { AppError } from "@/lib/errors";
import { pdfResponse } from "@/lib/pdf/render";
import { renderReportCardPdf } from "@/modules/academic/results.service";
import { idField } from "@/modules/students/person.schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/academic/report-cards/{id}/pdf — a published report card (Phase 4B-M6, AC15), rendered from its snapshot.
 * `reportcard.generate` at ALL, or ASSIGNED for the own class-teacher section; anything else → 404. `private, no-store`.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }, { status: 401 });
  const id = idField.safeParse((await params).id);
  if (!id.success) return Response.json({ error: { code: "NOT_FOUND", message: "Report card not found." } }, { status: 404 });
  try {
    const { pdf, fileName } = await renderReportCardPdf(ctx, id.data);
    return pdfResponse(pdf, fileName);
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error("report card pdf failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: { code: "INTERNAL", message: "The report card could not be generated." } }, { status: 503 });
  }
}
