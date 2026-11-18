import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { readStudentDocument } from "@/modules/students/students.service";

export const dynamic = "force-dynamic";
const PATH_ID = /^[A-Za-z0-9]{10,64}$/;

/**
 * GET /api/v1/students/:id/documents/:docId — scoped, audited download of a student's private document
 * (`student.read` scope + `student.document.read`; design §5.3). Missing, other-student and forbidden
 * documents all return 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  if (!PATH_ID.test(id) || !PATH_ID.test(docId)) return jsonError(404, "NOT_FOUND", "Document not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    return privateFileResponse(await readStudentDocument(ctx, id, docId));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Document not found.");
    console.error("student document download failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Document unavailable.");
  }
}
