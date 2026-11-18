import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { readStudentPhoto } from "@/modules/students/students.service";

export const dynamic = "force-dynamic";
const PATH_ID = /^[A-Za-z0-9]{10,64}$/;

/**
 * GET /api/v1/students/:id/photo — the student's current photo for anyone who may read that student
 * (`student.read` + record scope; design §5.3). Missing and forbidden both return 404 (no existence oracle).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Photo not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    return privateFileResponse(await readStudentPhoto(ctx, id));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Photo not found.");
    console.error("student photo failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Photo unavailable.");
  }
}
