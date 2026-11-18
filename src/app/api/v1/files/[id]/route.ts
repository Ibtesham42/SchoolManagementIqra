import { cookies } from "next/headers";
import { clientIpHash, getAuthContext } from "@/lib/auth/context";
import { sessionCookieName } from "@/lib/auth/session";
import { NotFoundError } from "@/lib/errors";
import { jsonError, privateFileResponse } from "@/lib/http/file-response";
import { anonymousFileMisses } from "@/lib/http/public-file-guards";
import { hitLocal, RULES } from "@/lib/rate-limit";
import { readStoredFile } from "@/modules/files/files.service";

export const dynamic = "force-dynamic";

const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "application/pdf"]);

/**
 * GET /api/v1/files/:id — PUBLIC files for anyone; PRIVATE files only for authorized, signed-in
 * users (audited). Missing and forbidden both return 404 so file ids can't be probed.
 *
 * Public endpoint rules (S-04): an in-process per-IP limit runs before any database access, and
 * "not found" answers for anonymous callers (no session cookie) are remembered briefly, so repeated
 * probes never reach the database. Requests without a session cookie don't touch the session table.
 * S-10: files that aren't publicly readable go through privateFileResponse (PDF = sandboxed attachment).
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[a-z0-9]{10,64}$/i.test(id)) return notFound();
  if (!hitLocal(RULES.filesPerIp, await clientIpHash()).allowed) {
    return Response.json({ error: { code: "RATE_LIMITED", message: "Too many requests. Please try again shortly." } }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  }
  const hasSession = !!(await cookies()).get(sessionCookieName())?.value;
  if (!hasSession && anonymousFileMisses.has(id)) return notFound();
  const ctx = hasSession ? await getAuthContext().catch(() => null) : null;
  try {
    const file = await readStoredFile(ctx, id);
    if (!file.publiclyReadable) return privateFileResponse(file);
    const disposition = INLINE_TYPES.has(file.mimeType) ? "inline" : "attachment";
    const asciiName = file.originalName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`,
        "X-Content-Type-Options": "nosniff",
        // Public files never change content under the same id (a new upload gets a new id).
        // Shared caches only for files anonymous visitors may read anyway (never PRIVATE or legacy).
        "Cache-Control": "public, max-age=86400, immutable",
        ETag: `"${file.sha256.slice(0, 32)}"`,
      },
    });
  } catch (e) {
    if (e instanceof NotFoundError) {
      if (!ctx) anonymousFileMisses.add(id);
      return notFound();
    }
    console.error("file download failed", e instanceof Error ? e.name : "unknown");
    return jsonError(503, "INTERNAL", "File unavailable.");
  }
}

function notFound() {
  return jsonError(404, "NOT_FOUND", "File not found.");
}
