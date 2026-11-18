import { describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, PayloadTooLargeError, RateLimitedError, ServiceBusyError, UnsupportedMediaTypeError, ValidationError, ConflictError } from "@/lib/errors";
import { assertSameOrigin, assertUploadHeaders, isSameOriginRequest, parseMultipart, readBodyWithLimit, singleFile, UploadSlots } from "@/lib/http/upload";
import { isUploadCode, UPLOAD_MESSAGES, uploadErrorCode } from "@/lib/http/upload-errors";
import { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";

/** KI-048 upload route building blocks (Phase 2B S4): CSRF, size before reading, capped reads, parsing. */
const h = (o: Record<string, string>) => new Headers(o);

describe("same-origin check (CSRF)", () => {
  it.each<[string, Record<string, string>, string | null, boolean]>([
    ["Origin matches Host", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, null, true],
    ["Origin matches APP_URL", { origin: "https://erp.example.test", host: "internal:3000" }, "https://erp.example.test", true],
    ["Sec-Fetch-Site same-origin + matching Origin", { origin: "http://localhost:3000", host: "localhost:3000", "sec-fetch-site": "same-origin" }, null, true],
    ["cross-site page", { origin: "https://evil.example", host: "127.0.0.1:3000" }, "http://127.0.0.1:3000", false],
    ["Sec-Fetch-Site cross-site even if Origin looks right", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", "sec-fetch-site": "cross-site" }, null, false],
    ["Sec-Fetch-Site same-site (sibling subdomain)", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000", "sec-fetch-site": "same-site" }, null, false],
    ["no Origin", { host: "127.0.0.1:3000" }, null, false],
    ["Origin: null (sandboxed frame)", { origin: "null", host: "127.0.0.1:3000" }, null, false],
    ["garbage Origin", { origin: "not a url", host: "127.0.0.1:3000" }, null, false],
    ["different port", { origin: "http://127.0.0.1:4000", host: "127.0.0.1:3000" }, null, false],
  ])("%s → %s", (_l, headers, appUrl, ok) => {
    expect(isSameOriginRequest(h(headers), appUrl)).toBe(ok);
  });
  it("assertSameOrigin throws ForbiddenError", () => {
    expect(() => assertSameOrigin(h({ origin: "https://evil.example", host: "a" }))).toThrow(ForbiddenError);
  });
});

describe("headers are checked BEFORE the body is read", () => {
  const mp = "multipart/form-data; boundary=----x";
  it("requires multipart/form-data", () => {
    expect(() => assertUploadHeaders(h({ "content-type": "application/json", "content-length": "10" }), UPLOAD_REQUEST_MAX_BYTES)).toThrow(UnsupportedMediaTypeError);
    expect(() => assertUploadHeaders(h({ "content-type": "multipart/form-data", "content-length": "10" }), UPLOAD_REQUEST_MAX_BYTES)).toThrow(UnsupportedMediaTypeError); // no boundary
  });
  it("requires a numeric Content-Length", () => {
    expect(() => assertUploadHeaders(h({ "content-type": mp }), UPLOAD_REQUEST_MAX_BYTES)).toThrow(ValidationError);
    expect(() => assertUploadHeaders(h({ "content-type": mp, "content-length": "-5" }), UPLOAD_REQUEST_MAX_BYTES)).toThrow(ValidationError);
  });
  it("refuses a declared size over 10 MB + envelope with 413; accepts the limit itself", () => {
    expect(() => assertUploadHeaders(h({ "content-type": mp, "content-length": String(UPLOAD_REQUEST_MAX_BYTES + 1) }), UPLOAD_REQUEST_MAX_BYTES)).toThrow(PayloadTooLargeError);
    expect(assertUploadHeaders(h({ "content-type": mp, "content-length": String(UPLOAD_REQUEST_MAX_BYTES) }), UPLOAD_REQUEST_MAX_BYTES)).toBe(UPLOAD_REQUEST_MAX_BYTES);
    expect(new PayloadTooLargeError("x").status).toBe(413);
  });
});

/** A stream that delivers `total` bytes in `chunk`-sized pieces and records whether it was cancelled. */
function stream(total: number, chunk = 64 * 1024) {
  let sent = 0;
  const state = { cancelled: false, pulled: 0 };
  const s = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= total) return c.close();
      const n = Math.min(chunk, total - sent);
      sent += n;
      state.pulled += n;
      c.enqueue(new Uint8Array(n).fill(7));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { s, state };
}

describe("capped body reader (Content-Length can lie)", () => {
  it("returns the bytes when within the cap", async () => {
    const { s } = stream(100_000);
    expect((await readBodyWithLimit(s, 200_000)).byteLength).toBe(100_000);
  });
  it("aborts as soon as the cap is passed — the rest is never read", async () => {
    const { s, state } = stream(50 * 1024 * 1024);
    await expect(readBodyWithLimit(s, 1024 * 1024)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(2 * 1024 * 1024);
  });
  it("refuses a missing body", async () => {
    await expect(readBodyWithLimit(null, 10)).rejects.toBeInstanceOf(ValidationError);
  });
});

async function multipart(parts: { name: string; value: string | Blob; filename?: string }[]) {
  const fd = new FormData();
  for (const p of parts) (p.value instanceof Blob ? fd.append(p.name, p.value, p.filename ?? "f") : fd.append(p.name, p.value));
  const req = new Request("http://x/", { method: "POST", body: fd });
  return { bytes: new Uint8Array(await req.arrayBuffer()), type: req.headers.get("content-type")! };
}

describe("multipart parsing and the single-file rule", () => {
  it("parses fields and one file from the capped buffer", async () => {
    const { bytes, type } = await multipart([{ name: "type", value: "BIRTH_CERTIFICATE" }, { name: "file", value: new Blob([new Uint8Array([1, 2, 3])]), filename: "bc.pdf" }]);
    const form = await parseMultipart(bytes, type);
    expect(form.get("type")).toBe("BIRTH_CERTIFICATE");
    expect(await singleFile(form, "file", DOCUMENT_MAX_BYTES)).toEqual({ bytes: new Uint8Array([1, 2, 3]), fileName: "bc.pdf" });
  });
  it("refuses no file, two files, an empty file and a file over the limit", async () => {
    const none = await parseMultipart(...(Object.values(await multipart([{ name: "type", value: "OTHER" }])) as [Uint8Array, string]));
    await expect(singleFile(none, "file", 10)).rejects.toBeInstanceOf(ValidationError);
    const two = await multipart([{ name: "file", value: new Blob(["a"]) }, { name: "file", value: new Blob(["b"]) }]);
    await expect(singleFile(await parseMultipart(two.bytes, two.type), "file", 10)).rejects.toBeInstanceOf(ValidationError);
    const empty = await multipart([{ name: "file", value: new Blob([]) }]);
    await expect(singleFile(await parseMultipart(empty.bytes, empty.type), "file", 10)).rejects.toThrow(/empty/);
    const big = await multipart([{ name: "file", value: new Blob([new Uint8Array(11)]) }]);
    await expect(singleFile(await parseMultipart(big.bytes, big.type), "file", 10)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
  it("a malformed body is a validation error, not a crash", async () => {
    await expect(parseMultipart(new TextEncoder().encode("garbage"), "multipart/form-data; boundary=zzz")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("in-process upload slots", () => {
  it("refuses with 503 when all slots are busy and frees the slot afterwards (also on error)", async () => {
    const slots = new UploadSlots(1);
    let release!: () => void;
    const first = slots.run(() => new Promise<string>((r) => (release = () => r("done"))));
    await expect(slots.run(async () => "second")).rejects.toBeInstanceOf(ServiceBusyError);
    expect(new ServiceBusyError().status).toBe(503);
    release();
    expect(await first).toBe("done");
    await expect(slots.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(slots.inUse).toBe(0);
  });
});

describe("fixed upload codes (no reflected text)", () => {
  it.each<[unknown, string]>([
    [new PayloadTooLargeError("x"), "too_large"],
    [new UnsupportedMediaTypeError(), "invalid"],
    [new RateLimitedError(), "rate_limited"],
    [new ServiceBusyError(), "busy"],
    [new ForbiddenError(), "forbidden"],
    [new NotFoundError(), "not_found"],
    [new ValidationError("This file type isn't accepted here. Allowed: PDF."), "bad_type"],
    [new ValidationError("The photo must be a JPEG or PNG image."), "bad_type"],
    [new ValidationError("This photo couldn't be processed. Use a clear JPEG or PNG image."), "photo_failed"],
    [new ValidationError("Photo processing is unavailable on this server, so the photo was not saved."), "photo_failed"],
    [new ValidationError("The file is 12.0 MB; the limit is 10.0 MB."), "too_large"],
    [new ValidationError("Choose the document type."), "invalid"],
    [new ConflictError("A rejected application can't be given new documents."), "closed"],
    [new Error("database exploded"), "failed"],
  ])("%s → %s", (e, code) => {
    expect(uploadErrorCode(e)).toBe(code);
  });
  it("only known codes are accepted from the URL", () => {
    expect(isUploadCode("ok")).toBe(true);
    expect(isUploadCode("<script>")).toBe(false);
    expect(isUploadCode("constructor")).toBe(false);
    for (const m of Object.values(UPLOAD_MESSAGES)) expect(m).not.toMatch(/[<>]/);
  });
});
