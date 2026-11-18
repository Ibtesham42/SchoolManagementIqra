/**
 * Content-based file type detection ("magic bytes"). The declared name/extension and the
 * browser-supplied MIME type are never trusted: a renamed .html or .exe is rejected.
 * SVG is deliberately unsupported (it can carry scripts).
 */
export type DetectedType = "image/png" | "image/jpeg" | "image/webp" | "application/pdf" | "docx" | "xlsx";

export const MIME: Record<DetectedType, string> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/webp": "image/webp",
  "application/pdf": "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export const EXTENSION: Record<DetectedType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
  docx: "docx",
  xlsx: "xlsx",
};

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((v, i) => b[offset + i] === v);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function detectFileType(bytes: Uint8Array): DetectedType | null {
  if (bytes.length < 12) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  if (startsWith(bytes, ascii("%PDF-"))) return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // Office Open XML is a ZIP; distinguish by the part names stored in the archive.
    const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64 * 1024))).toString("latin1");
    if (!head.includes("[Content_Types].xml")) return null;
    if (head.includes("word/")) return "docx";
    if (head.includes("xl/")) return "xlsx";
  }
  return null;
}
