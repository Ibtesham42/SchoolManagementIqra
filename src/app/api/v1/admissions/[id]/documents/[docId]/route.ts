import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { readApplicationDocument } from "@/modules/admissions/documents.service";
import { PATH_ID } from "@/modules/admissions/documents.schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admissions/:id/documents/:docId — scoped, audited download of a private admission
 * document. Missing, other-application and forbidden documents all return 404 (no existence oracle).
 * PDFs download as attachments in a sandbox; images display inline. Never cached.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  if (!PATH_ID.test(id) || !PATH_ID.test(docId)) return notFound();
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return Response.json({ error: { code: "UNAUTHENTICATED", message: "Please sign in to continue." } }, { status: 401 });
  try {
    const file = await readApplicationDocument(ctx, id, docId);
    const isPdf = file.mimeType === "application/pdf";
    const asciiName = file.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `${isPdf ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(isPdf ? { "Content-Security-Policy": "sandbox" } : {}),
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return notFound();
    console.error("document download failed", e instanceof Error ? e.name : "unknown");
    return Response.json({ error: { code: "INTERNAL", message: "Document unavailable." } }, { status: 503 });
  }
}

function notFound() {
  return Response.json({ error: { code: "NOT_FOUND", message: "Document not found." } }, { status: 404 });
}
