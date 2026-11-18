import type { ReactElement } from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";

/**
 * Server-side PDF rendering (ADR-012). Pure JS — no headless browser, works on any Node host.
 * Templates live in modules/documents/templates and must be wrapped in <Document>.
 * Built-in PDF fonts only (Helvetica) so rendering needs no network; Indian-language fonts are a
 * later, explicit addition (bundled font files, never downloaded at runtime).
 */
export async function renderPdf(document: ReactElement): Promise<Buffer> {
  // Templates are components whose root is <Document>; react-pdf types expect the Document element itself.
  return renderToBuffer(document as ReactElement<DocumentProps>);
}

export function pdfResponse(bytes: Buffer, fileName: string, disposition: "inline" | "attachment" = "inline"): Response {
  const safe = fileName.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(bytes.length),
      "Content-Disposition": `${disposition}; filename="${safe}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
