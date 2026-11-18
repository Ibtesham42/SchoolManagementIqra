import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { PATH_ID } from "@/modules/hr/hr.schemas";
import { readEmployeeDocument } from "@/modules/hr/employee-documents.service";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/employees/:id/documents/:docId — owner-bound, audited download of a staff document (Phase 3A M4b):
 * personal tier on the record (ALL, or SELF on the own record) + the file layer's purpose/owner check. Missing,
 * other-employee and forbidden documents all return 404. PDFs download as sandboxed attachments.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  if (!PATH_ID.test(id) || !PATH_ID.test(docId)) return jsonError(404, "NOT_FOUND", "Document not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    return privateFileResponse(await readEmployeeDocument(ctx, id, docId));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Document not found.");
    console.error("staff document download failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Document unavailable.");
  }
}
