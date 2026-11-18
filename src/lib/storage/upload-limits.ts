/**
 * Upload size limits and messages shared by the server (`upload-rules.ts`) and the browser
 * (G7 bug B2). Pure and dependency-free so client components can import it.
 *
 * Next.js rejects any server-action request body over 1 MB *before* the action runs, showing the
 * generic error page instead of our message. Server-action uploads must therefore stay below that
 * (the logo limit is 800 KB) and are also checked in the browser before submitting. Larger uploads
 * (e.g. future 10 MB student/staff documents) need a dedicated upload route handler — see
 * docs/KNOWN_ISSUES.md KI-048.
 */

/** Next.js default server-action body limit (bytes). */
export const SERVER_ACTION_BODY_LIMIT = 1024 * 1024;

/** School logo limit (bytes): leaves room for the multipart envelope under the 1 MB body limit. */
export const LOGO_MAX_BYTES = 800 * 1024;

/**
 * Student/admission documents and photo uploads (KI-048): sent to the dedicated upload route, never a
 * server action. 10 MB per file; the route also refuses request bodies over the file limit plus a small
 * multipart envelope BEFORE reading them.
 */
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_ENVELOPE_BYTES = 64 * 1024;
export const UPLOAD_REQUEST_MAX_BYTES = DOCUMENT_MAX_BYTES + UPLOAD_ENVELOPE_BYTES;
/** A processed student photo (600×600 JPEG) is far smaller; this bounds what is stored. */
export const PHOTO_STORED_MAX_BYTES = 2 * 1024 * 1024;

export const formatBytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`);

export const fileTooLargeMessage = (bytes: number, maxBytes: number) => `The file is ${formatBytes(bytes)}; the limit is ${formatBytes(maxBytes)}.`;

/** Browser-side pre-check: an error message, or null when the file may be submitted. */
export function checkFileSize(file: { size: number } | null | undefined, maxBytes: number): string | null {
  if (!file || file.size === 0) return null; // "choose a file" is handled by the form / server
  return file.size > maxBytes ? fileTooLargeMessage(file.size, maxBytes) : null;
}
