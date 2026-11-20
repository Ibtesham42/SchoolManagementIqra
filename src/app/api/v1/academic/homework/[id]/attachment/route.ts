import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { assertSameOrigin, assertUploadHeaders, parseMultipart, readBodyWithLimit, singleFile, UploadSlots } from "@/lib/http/upload";
import { errorStatus, HOMEWORK_UPLOAD_MESSAGES, uploadErrorCode, type UploadCode } from "@/lib/http/upload-errors";
import { enforce, RULES } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/rbac/authorize";
import { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";
import { homeworkRefSchema } from "@/modules/academic/homework.schemas";
import { attachHomeworkFile, readHomeworkAttachment } from "@/modules/academic/homework.service";

export const dynamic = "force-dynamic";

const PATH_ID = /^[A-Za-z0-9]{10,64}$/;
/** At most 2 uploads processed at once per server instance (each holds ≤ 10 MB). */
const slots = new UploadSlots(2);

/**
 * POST /api/v1/academic/homework/:id/attachment — add or replace the homework's attachment (Phase 4C, KI-094; PDF,
 * JPEG or PNG ≤ 10 MB, private and encrypted). Same pipeline as staff documents: same-origin → session → permission gate
 * (before an upload slot or the body is taken) → rate limit → headers → capped read with deadline → multipart → fields
 * → service (scope checked before storing; version checked under the lock). Plain form posts get a 303 back to the
 * homework screen with a fixed status code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  let section = "";
  const back = (code: UploadCode) => new Response(null, { status: 303, headers: { Location: `/erp/academic/homework?${section ? `section=${encodeURIComponent(section)}&` : ""}upload=${code}` } });
  try {
    if (!PATH_ID.test(id)) throw new NotFoundError();
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    if (!hasPermission(ctx, "homework.manage")) throw new ForbiddenError();
    await enforce(RULES.upload, ctx.userId);
    assertUploadHeaders(request.headers, UPLOAD_REQUEST_MAX_BYTES);
    await slots.run(async () => {
      const form = await parseMultipart(await readBodyWithLimit(request.body, UPLOAD_REQUEST_MAX_BYTES), request.headers.get("content-type")!);
      const s = form.get("section");
      if (typeof s === "string" && PATH_ID.test(s)) section = s;
      const ref = homeworkRefSchema.safeParse({ id, version: form.get("version") ?? "" });
      if (!ref.success) throw new ValidationError("Reload the page and try again.");
      await attachHomeworkFile(ctx, ref.data, await singleFile(form, "file", DOCUMENT_MAX_BYTES));
    });
    return html ? back("ok") : Response.json({ ok: true }, { status: 201 });
  } catch (e) {
    const code = uploadErrorCode(e);
    if (code === "failed") console.error("homework attachment upload failed", e instanceof Error ? e.name : "unknown");
    if (html) return e instanceof UnauthenticatedError ? new Response(null, { status: 303, headers: { Location: "/login" } }) : back(code);
    return Response.json({ error: { code, message: HOMEWORK_UPLOAD_MESSAGES[code] } }, { status: errorStatus(e) });
  }
}

/** GET — owner-bound, audited download for whoever may read the homework. Missing and out-of-scope both → 404. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!PATH_ID.test(id)) return jsonError(404, "NOT_FOUND", "Attachment not found.");
  const ctx = await getAuthContext().catch(() => null);
  if (!ctx) return jsonError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  try {
    return privateFileResponse(await readHomeworkAttachment(ctx, id));
  } catch (e) {
    if (e instanceof NotFoundError || e instanceof ForbiddenError) return jsonError(404, "NOT_FOUND", "Attachment not found.");
    console.error("homework attachment download failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "Attachment unavailable.");
  }
}
