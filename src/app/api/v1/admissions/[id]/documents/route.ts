import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { assertSameOrigin, assertUploadHeaders, parseMultipart, readBodyWithLimit, singleFile, UploadSlots } from "@/lib/http/upload";
import { errorStatus, UPLOAD_MESSAGES, uploadErrorCode, type UploadCode } from "@/lib/http/upload-errors";
import { enforce, RULES } from "@/lib/rate-limit";
import { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";
import { addApplicationDocument } from "@/modules/admissions/documents.service";
import { documentUploadFieldsSchema, PATH_ID } from "@/modules/admissions/documents.schemas";

export const dynamic = "force-dynamic";

/** At most 2 uploads processed at once per server instance (each holds ≤ 10 MB; photos also decode). */
const slots = new UploadSlots(2);

/**
 * POST /api/v1/admissions/:id/documents — authenticated private document upload (KI-048; 10 MB).
 * Same-origin → session → rate limit → headers (type, Content-Length ≤ limit; body NOT read yet) →
 * capped read → multipart → fields → service (RBAC, content detection, photo re-encoding, encryption).
 * Plain form posts (Accept: text/html) get a 303 back to the page with a fixed status code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  const back = (code: UploadCode, from: string | null) => {
    const page = from === "detail" ? `/erp/admissions/${id}` : `/erp/admissions/${id}/edit?step=5`; // fixed targets only
    return new Response(null, { status: 303, headers: { Location: `${page}${page.includes("?") ? "&" : "?"}upload=${code}` } });
  };
  let from: string | null = null;
  try {
    if (!PATH_ID.test(id)) throw new NotFoundError();
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    // S-01: refuse non-uploaders BEFORE an upload slot or the body (up to 10 MB) is taken. The service
    // repeats the authoritative checks; this cheap gate only stops low-privilege users tying up resources.
    if (!hasPermission(ctx, "student.document.manage") || scopeFor(ctx, "admission.read") !== "ALL") throw new ForbiddenError();
    await enforce(RULES.upload, ctx.userId);
    assertUploadHeaders(request.headers, UPLOAD_REQUEST_MAX_BYTES);
    const doc = await slots.run(async () => {
      const form = await parseMultipart(await readBodyWithLimit(request.body, UPLOAD_REQUEST_MAX_BYTES), request.headers.get("content-type")!);
      from = typeof form.get("from") === "string" ? (form.get("from") as string) : null;
      const fields = documentUploadFieldsSchema.safeParse({ type: form.get("type") ?? "", label: form.get("label") ?? "" });
      if (!fields.success) throw new ValidationError("Choose the document type.");
      return addApplicationDocument(ctx, id, fields.data, await singleFile(form, "file", DOCUMENT_MAX_BYTES));
    });
    return html ? back("ok", from) : Response.json({ document: doc }, { status: 201 });
  } catch (e) {
    const code = uploadErrorCode(e);
    if (code === "failed") console.error("document upload failed", e instanceof Error ? e.name : "unknown");
    if (html) return e instanceof UnauthenticatedError ? new Response(null, { status: 303, headers: { Location: "/login" } }) : back(code, from);
    return Response.json({ error: { code, message: UPLOAD_MESSAGES[code] } }, { status: errorStatus(e) });
  }
}
