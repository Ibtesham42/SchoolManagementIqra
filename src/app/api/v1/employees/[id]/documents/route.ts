import { getAuthContext } from "@/lib/auth/context";
import { ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { hasPermission } from "@/lib/rbac/authorize";
import { assertSameOrigin, assertUploadHeaders, parseMultipart, readBodyWithLimit, singleFile, UploadSlots } from "@/lib/http/upload";
import { errorStatus, STAFF_UPLOAD_MESSAGES, uploadErrorCode, type UploadCode } from "@/lib/http/upload-errors";
import { enforce, RULES } from "@/lib/rate-limit";
import { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";
import { canBrowseEmployees, canReadPersonal } from "@/modules/hr/hr.policy";
import { employeeDocumentFieldsSchema, PATH_ID } from "@/modules/hr/hr.schemas";
import { addEmployeeDocument } from "@/modules/hr/employee-documents.service";

export const dynamic = "force-dynamic";

/** At most 2 uploads processed at once per server instance (each holds ≤ 10 MB; photos also decode). */
const slots = new UploadSlots(2);

/**
 * POST /api/v1/employees/:id/documents — staff document or photo upload (Phase 3A M4b, H8; 10 MB). Same pipeline
 * as the admission upload: same-origin → session → S-01 gate (manage + directory + personal tier, BEFORE an upload
 * slot or the body is taken) → rate limit → headers → capped read with deadline → multipart → fields → service.
 * Plain form posts (Accept: text/html) get a 303 back to the profile with a fixed status code.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const html = (request.headers.get("accept") ?? "").includes("text/html");
  const back = (code: UploadCode) => new Response(null, { status: 303, headers: { Location: `/erp/hr/employees/${id}?upload=${code}#documents` } });
  try {
    if (!PATH_ID.test(id)) throw new NotFoundError();
    assertSameOrigin(request.headers, process.env.APP_URL);
    const ctx = await getAuthContext();
    if (!ctx) throw new UnauthenticatedError();
    if (!hasPermission(ctx, "employee.document.manage") || !canBrowseEmployees(ctx) || !canReadPersonal(ctx)) throw new ForbiddenError();
    await enforce(RULES.upload, ctx.userId);
    assertUploadHeaders(request.headers, UPLOAD_REQUEST_MAX_BYTES);
    const doc = await slots.run(async () => {
      const form = await parseMultipart(await readBodyWithLimit(request.body, UPLOAD_REQUEST_MAX_BYTES), request.headers.get("content-type")!);
      const fields = employeeDocumentFieldsSchema.safeParse({ type: form.get("type") ?? "", label: form.get("label") ?? "" });
      if (!fields.success) throw new ValidationError("Choose the document type.");
      return addEmployeeDocument(ctx, id, fields.data, await singleFile(form, "file", DOCUMENT_MAX_BYTES));
    });
    return html ? back("ok") : Response.json({ document: doc }, { status: 201 });
  } catch (e) {
    const code = uploadErrorCode(e);
    if (code === "failed") console.error("staff document upload failed", e instanceof Error ? e.name : "unknown");
    if (html) return e instanceof UnauthenticatedError ? new Response(null, { status: 303, headers: { Location: "/login" } }) : PATH_ID.test(id) ? back(code) : new Response(null, { status: 303, headers: { Location: "/erp/hr/employees" } });
    return Response.json({ error: { code, message: STAFF_UPLOAD_MESSAGES[code] } }, { status: errorStatus(e) });
  }
}
