import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { PATH_ID } from "@/modules/hr/hr.schemas";
import { readEmployeePhoto } from "@/modules/hr/employee-documents.service";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/employees/:id/photo — the staff member's current photo for anyone who may read the record
 * (`employee.read` ALL, or SELF on the own record; directory data, H6). Missing and forbidden both return 404.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Photo not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    return privateFileResponse(await readEmployeePhoto(ctx, id));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Photo not found.");
    console.error("staff photo failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Photo unavailable.");
  }
}
