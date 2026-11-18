import { ForbiddenError, PayloadTooLargeError, RequestTimeoutError, ServiceBusyError, UnsupportedMediaTypeError, ValidationError } from "@/lib/errors";
import { formatBytes } from "@/lib/storage/upload-limits";

/**
 * Building blocks for authenticated upload route handlers (KI-048). Pure or stream-level — no database,
 * no auth lookups — so they are unit-tested directly.
 *
 * Order in a route: origin check → session → rate limit → content-type/length check (NO body read) →
 * capped body read → multipart parse → field validation → service. A request that claims a small
 * Content-Length but streams more is aborted at the cap; one without Content-Length is refused.
 */

/**
 * CSRF guard for cookie-authenticated mutations outside server actions. Browsers always send `Origin`
 * on cross-origin and on same-origin POST requests; an attacker's page can't forge it. Accepted when the
 * Origin's host equals the request's Host (what Next.js does for server actions) or the configured
 * APP_URL host. `Sec-Fetch-Site`, when present, must be same-origin.
 */
export function isSameOriginRequest(headers: Headers, appUrl?: string | null): boolean {
  const site = headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (!origin || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const host = headers.get("host");
  if (host && originHost === host) return true;
  if (appUrl) {
    try {
      if (originHost === new URL(appUrl).host) return true;
    } catch {
      /* invalid APP_URL → no match */
    }
  }
  return false;
}

export function assertSameOrigin(headers: Headers, appUrl?: string | null): void {
  if (!isSameOriginRequest(headers, appUrl)) throw new ForbiddenError("This upload must come from the school's own website.");
}

/** Multipart only; Content-Length required and within the limit — checked BEFORE reading the body. */
export function assertUploadHeaders(headers: Headers, maxBytes: number): number {
  const type = headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) throw new UnsupportedMediaTypeError();
  const raw = headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw.trim())) throw new ValidationError("The upload size is unknown. Please try again from the upload form.");
  const length = Number(raw);
  if (length > maxBytes) throw new PayloadTooLargeError(`The upload is ${formatBytes(length)}; the limit is ${formatBytes(maxBytes)}.`);
  return length;
}

/**
 * Overall deadline for reading an upload body (S-01): a trickled body can't hold an upload slot until the
 * server's request timeout. 120 s still allows 10 MB over a slow (~1 Mbit/s) mobile uplink.
 */
export const UPLOAD_READ_TIMEOUT_MS = 120_000;

/**
 * Reads a request body, aborting as soon as more than `maxBytes` arrive (whatever Content-Length said) or
 * when the whole body hasn't arrived within the deadline (the stream is cancelled either way).
 */
export async function readBodyWithLimit(body: ReadableStream<Uint8Array> | null, maxBytes: number, opts: { timeoutMs?: number } = {}): Promise<Uint8Array> {
  if (!body) throw new ValidationError("The upload was empty.");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError()), opts.timeoutMs ?? UPLOAD_READ_TIMEOUT_MS);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new PayloadTooLargeError(`The upload is larger than ${formatBytes(maxBytes)}.`);
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined); // also settles a read still pending after the deadline
    throw e;
  } finally {
    clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* already released by cancel */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Parses an already size-capped multipart body (the platform parser never sees an uncapped stream). */
export async function parseMultipart(bytes: Uint8Array, contentType: string): Promise<FormData> {
  try {
    return await new Response(bytes as unknown as BodyInit, { headers: { "content-type": contentType } }).formData();
  } catch {
    throw new ValidationError("The upload couldn't be read. Please try again from the upload form.");
  }
}

/** Exactly one file in field `name`, non-empty, within `maxBytes`. */
export async function singleFile(form: FormData, name: string, maxBytes: number): Promise<{ bytes: Uint8Array; fileName: string }> {
  const files = form.getAll(name).filter((v): v is File => typeof v !== "string");
  if (files.length !== 1) throw new ValidationError("Choose one file.", [{ path: "file", message: "Choose one file." }]);
  const file = files[0];
  if (file.size === 0) throw new ValidationError("The file is empty.", [{ path: "file", message: "Choose a file." }]);
  if (file.size > maxBytes) throw new PayloadTooLargeError(`The file is ${formatBytes(file.size)}; the limit is ${formatBytes(maxBytes)}.`);
  return { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name };
}

/**
 * In-process limit on simultaneous uploads (each holds up to ~10 MB in memory, a photo also a decode
 * buffer). Excess requests get a friendly 503 instead of exhausting a small server's memory.
 */
export class UploadSlots {
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) throw new ServiceBusyError("Too many uploads at once. Please try again in a moment.");
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
    }
  }
  get inUse(): number {
    return this.active;
  }
}
