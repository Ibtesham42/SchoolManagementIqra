import { getAuthContext } from "@/lib/auth/context";
import { AppError } from "@/lib/errors";
import { pdfResponse } from "@/lib/pdf/render";
import { enforce, RULES } from "@/lib/rate-limit";
import { renderReceiptPdf } from "@/modules/fees/receipts.service";
import { idField } from "@/modules/students/person.schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/fees/receipts/{id}/pdf — a fee receipt PDF (Phase 5B-M2, FC14), rendered from its snapshot. Readers of
 * receipts (`fee.read`, `fee.collect` or `fee.refund` at ALL); anything else → 403, unknown → 404. Rate limited per
 * user (`RULES.receiptPdf`). Each call counts a print (DUPLICATE from the second), so a cross-site request is refused
 * (Sec-Fetch-Site) — another site can't spend prints. `private, no-store`.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return Response.json({ error: { code: "FORBIDDEN", message: "Open the receipt from the school ERP." } }, { status: 403 });
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }, { status: 401 });
  const id = idField.safeParse((await params).id);
  if (!id.success) return Response.json({ error: { code: "NOT_FOUND", message: "Receipt not found." } }, { status: 404 });
  try {
    await enforce(RULES.receiptPdf, ctx.userId);
    const { pdf, fileName } = await renderReceiptPdf(ctx, id.data);
    return pdfResponse(pdf, fileName);
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error("fee receipt pdf failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: { code: "INTERNAL", message: "The receipt could not be generated." } }, { status: 503 });
  }
}
