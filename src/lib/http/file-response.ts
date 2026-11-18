/**
 * Response for a private file download (pure — unit tested). Never cached, never sniffed; PDFs download
 * as attachments inside a CSP sandbox, images display inline. The file name is sent both as an ASCII
 * fallback and RFC 5987-encoded.
 */
export function privateFileResponse(file: { bytes: Uint8Array; mimeType: string; originalName: string }): Response {
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
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}
