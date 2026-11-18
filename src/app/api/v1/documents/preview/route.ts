import { getAuthContext } from "@/lib/auth/context";
import { AppError } from "@/lib/errors";
import { pdfResponse } from "@/lib/pdf/render";
import { renderDocumentPreview } from "@/modules/documents/documents.service";

export const dynamic = "force-dynamic";

/** GET /api/v1/documents/preview — branded sample PDF (settings.read). */
export async function GET() {
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in." } }, { status: 401 });
  try {
    return pdfResponse(await renderDocumentPreview(ctx), "document-preview.pdf");
  } catch (e) {
    if (e instanceof AppError) return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
    console.error("document preview failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: { code: "INTERNAL", message: "The document could not be generated." } }, { status: 503 });
  }
}
