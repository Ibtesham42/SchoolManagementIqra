import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, RateLimitedError, ValidationError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { DOCUMENT_MAX_BYTES, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";

/**
 * Route-level tests for the KI-048 upload route and the scoped download route. The admissions document
 * service (RBAC, content detection, encryption, DB), the session lookup and the DB-backed rate limiter are
 * replaced by plain stubs, so only the routes' own behaviour is checked: CSRF, size-before-read, status
 * codes, fixed redirect targets and codes, download headers. Prisma is not mocked; the service's database
 * behaviour is covered by tests/integration (pending the Test branch).
 */
type Ctx = AuthContext | null;
/** A real permission set from the catalog (the S-01 gate checks permissions before the body is read). */
function ctxFor(roleKey: string, over: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "synthetic", displayName: "Synthetic", roleKeys: [roleKey], isSuperAdmin: false, permissions, sessionId: "s1", ...over };
}
const officer = () => ctxFor("ADMISSION_OFFICER");
let ctx: Ctx = officer();
let rateLimited = false;
let addBehaviour: (args: unknown[]) => Promise<unknown> = async () => ({ id: "doc1", type: "BIRTH_CERTIFICATE" });
let readBehaviour: () => Promise<unknown> = async () => {
  throw new NotFoundError();
};
const calls: { add: unknown[][]; read: number } = { add: [], read: 0 };

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
const bodyReads = { count: 0 };
vi.mock("@/lib/http/upload", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@/lib/http/upload")>();
  return {
    ...orig,
    readBodyWithLimit: (...args: Parameters<typeof orig.readBodyWithLimit>) => {
      bodyReads.count++;
      return orig.readBodyWithLimit(...args);
    },
  };
});
vi.mock("@/lib/rate-limit", () => ({
  RULES: { upload: { name: "upload", limit: 30, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/admissions/documents.service", () => ({
  addApplicationDocument: (...args: unknown[]) => {
    calls.add.push(args);
    return addBehaviour(args);
  },
  readApplicationDocument: () => {
    calls.read++;
    return readBehaviour();
  },
}));

const { POST } = await import("@/app/api/v1/admissions/[id]/documents/route");
const { GET } = await import("@/app/api/v1/admissions/[id]/documents/[docId]/route");

const APP = "http://127.0.0.1:3000";
const APP_ID = "cmapplication0001";
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF"));

async function body(fields: Record<string, string>, file: Uint8Array | null = PDF) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("file", new Blob([file as unknown as BlobPart]), "bc.pdf");
  const r = new Request(APP, { method: "POST", body: fd });
  return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type")! };
}

async function upload(opts: { fields?: Record<string, string>; file?: Uint8Array | null; headers?: Record<string, string>; html?: boolean; id?: string; rawBody?: BodyInit; omitLength?: boolean } = {}) {
  const { bytes, type } = await body(opts.fields ?? { type: "BIRTH_CERTIFICATE", label: "" }, opts.file === undefined ? PDF : opts.file);
  const headers: Record<string, string> = { origin: APP, "content-type": type, accept: opts.html ? "text/html,application/xhtml+xml" : "application/json", ...(opts.omitLength ? {} : { "content-length": String(bytes.byteLength) }), ...opts.headers };
  const req = new Request(`${APP}/api/v1/admissions/${opts.id ?? APP_ID}/documents`, { method: "POST", headers, body: opts.rawBody ?? (bytes as unknown as BodyInit), ...(opts.rawBody ? { duplex: "half" } : {}) } as RequestInit);
  return POST(req, { params: Promise.resolve({ id: opts.id ?? APP_ID }) });
}

beforeAll(() => {
  process.env.APP_URL = APP;
});
afterAll(() => {
  delete process.env.APP_URL;
});
beforeEach(() => {
  ctx = officer();
  rateLimited = false;
  calls.add = [];
  calls.read = 0;
  addBehaviour = async () => ({ id: "doc1", type: "BIRTH_CERTIFICATE" });
});

describe("POST /api/v1/admissions/:id/documents (upload, KI-048)", () => {
  it("uploads a document: 201 JSON, the service gets the bytes, the fields and the file name", async () => {
    const res = await upload();
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ document: { id: "doc1", type: "BIRTH_CERTIFICATE" } });
    expect(calls.add).toHaveLength(1);
    const [, id, fields, file] = calls.add[0] as [unknown, string, unknown, { bytes: Uint8Array; fileName: string }];
    expect(id).toBe(APP_ID);
    expect(fields).toEqual({ type: "BIRTH_CERTIFICATE", label: null });
    expect([Buffer.from(file.bytes).equals(Buffer.from(PDF)), file.fileName]).toEqual([true, "bc.pdf"]);
  });

  it("refuses cross-site requests (CSRF) before touching the session or the service", async () => {
    const res = await upload({ headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
    expect(calls.add).toHaveLength(0);
    expect((await upload({ headers: { origin: APP, "sec-fetch-site": "cross-site" } })).status).toBe(403);
  });

  it("refuses requests without a session (401 JSON; plain forms go to the login page)", async () => {
    ctx = null;
    const res = await upload();
    expect(res.status).toBe(401);
    // Pre-S5 finding: a signed-out user is told to sign in, not that they lack permission.
    expect((await res.json()).error).toEqual({ code: "signed_out", message: "Please sign in again, then retry the upload." });
    const html = await upload({ html: true });
    expect([html.status, html.headers.get("location")]).toEqual([303, "/login"]);
    expect(calls.add).toHaveLength(0);
  });

  it("rate limit → 429, service not called", async () => {
    rateLimited = true;
    const res = await upload();
    expect(res.status).toBe(429);
    expect(calls.add).toHaveLength(0);
  });

  it("a declared body over 10 MB + envelope → 413 WITHOUT reading the body", async () => {
    let pulled = 0;
    // highWaterMark 0: the stream produces data only when someone reads (no eager pre-fill).
    const s = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(1024));
        },
      },
      { highWaterMark: 0 },
    );
    const res = await upload({ rawBody: s, headers: { "content-length": String(UPLOAD_REQUEST_MAX_BYTES + 1) } });
    expect(res.status).toBe(413);
    expect(pulled).toBe(0);
    expect(calls.add).toHaveLength(0);
  });

  it("a lying Content-Length is caught at the cap while streaming → 413", async () => {
    let sent = 0;
    const s = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > UPLOAD_REQUEST_MAX_BYTES + 1024 * 1024) return c.close();
        sent += 256 * 1024;
        c.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const res = await upload({ rawBody: s, headers: { "content-length": "1000" } });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(UPLOAD_REQUEST_MAX_BYTES + 512 * 1024);
    expect(calls.add).toHaveLength(0);
  });

  it("missing Content-Length → 422; not multipart → 415", async () => {
    expect((await upload({ omitLength: true })).status).toBe(422);
    expect((await upload({ headers: { "content-type": "application/json" } })).status).toBe(415);
    expect(calls.add).toHaveLength(0);
  });

  it("a file over 10 MB inside an allowed envelope → 413 (never reaches the service)", async () => {
    const res = await upload({ file: new Uint8Array(DOCUMENT_MAX_BYTES + 1) });
    // The body is over the route limit, so it is refused before reading.
    expect(res.status).toBe(413);
    expect(calls.add).toHaveLength(0);
  });

  it("no file / unknown type → 422, service not called", async () => {
    expect((await upload({ file: null })).status).toBe(422);
    expect((await upload({ fields: { type: "AADHAAR", label: "" } })).status).toBe(422);
    expect(calls.add).toHaveLength(0);
  });

  it("a malformed application id → 404 without any work", async () => {
    expect((await upload({ id: "../../etc" })).status).toBe(404);
    expect(calls.add).toHaveLength(0);
  });

  it("service refusals map to their status and a FIXED code (no service text reflected)", async () => {
    addBehaviour = async () => {
      throw new ValidationError("This file type isn't accepted here. Allowed: PDF, JPEG, PNG.");
    };
    const bad = await upload();
    expect([bad.status, (await bad.json()).error.code]).toEqual([422, "bad_type"]);
    addBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await upload()).status).toBe(403);
    addBehaviour = async () => {
      throw new Error("internal details must not leak");
    };
    const boom = await upload();
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("internal details");
  });

  it("plain form posts: 303 to a FIXED page with a fixed code; `from` can only pick between the two known pages", async () => {
    const ok = await upload({ html: true, fields: { type: "BIRTH_CERTIFICATE", label: "", from: "detail" } });
    expect([ok.status, ok.headers.get("location")]).toEqual([303, `/erp/admissions/${APP_ID}?upload=ok`]);
    const evil = await upload({ html: true, fields: { type: "BIRTH_CERTIFICATE", label: "", from: "https://evil.example/" } });
    expect(evil.headers.get("location")).toBe(`/erp/admissions/${APP_ID}/edit?step=5&upload=ok`);
    addBehaviour = async () => {
      throw new ValidationError("This photo couldn't be processed. Use a clear JPEG or PNG image.");
    };
    const failed = await upload({ html: true, fields: { type: "PHOTO", label: "", from: "edit" } });
    expect(failed.headers.get("location")).toBe(`/erp/admissions/${APP_ID}/edit?step=5&upload=photo_failed`);
  });
});

describe("GET /api/v1/admissions/:id/documents/:docId (download)", () => {
  const get = (id = APP_ID, docId = "0123456789abcdef0123456789abcdef") => GET(new Request(`${APP}/api/v1/admissions/${id}/documents/${docId}`), { params: Promise.resolve({ id, docId }) });
  const file = (over: Record<string, unknown> = {}) => ({ bytes: Buffer.from("%PDF-1.7"), mimeType: "application/pdf", originalName: "birth certificate.pdf", visibility: "PRIVATE", sha256: "a".repeat(64), publiclyReadable: false, type: "BIRTH_CERTIFICATE", ...over });

  it("no session → 401; malformed ids → 404 without a lookup", async () => {
    ctx = null;
    expect((await get()).status).toBe(401);
    ctx = officer();
    expect((await get("x/../y")).status).toBe(404);
    expect(calls.read).toBe(0);
  });
  it("missing and forbidden documents look the same (404)", async () => {
    readBehaviour = async () => {
      throw new NotFoundError();
    };
    expect((await get()).status).toBe(404);
    readBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await get()).status).toBe(404);
  });
  it("PDF: attachment, sandboxed, never cached, nosniff", async () => {
    readBehaviour = async () => file();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="birth certificate.pdf"/);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("photo: inline image, still private and never cached", async () => {
    readBehaviour = async () => file({ bytes: Buffer.from([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", originalName: "photo.jpg", type: "PHOTO" });
    const res = await get();
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("unexpected errors → 503 without details", async () => {
    readBehaviour = async () => {
      throw new Error("disk path C:\\secret");
    };
    const res = await get();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain("secret");
  });
});

describe("S-01: non-uploaders are refused BEFORE an upload slot or the body is taken", () => {
  const watchedBody = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
        controller.close();
      },
    });
  const post = (stream: ReadableStream<Uint8Array>) =>
    POST(
      new Request(`${APP}/api/v1/admissions/${APP_ID}/documents`, {
        method: "POST",
        headers: { origin: APP, "content-type": "multipart/form-data; boundary=x", "content-length": "16", accept: "application/json" },
        body: stream,
        duplex: "half",
      } as RequestInit),
      { params: Promise.resolve({ id: APP_ID }) },
    );
  for (const [label, make] of [
    ["Teacher (no student.document.manage)", () => ctxFor("TEACHER")],
    ["Accountant (no admission.read ALL)", () => ctxFor("ACCOUNTANT")],
    ["Admission Officer with a pending password change", () => ctxFor("ADMISSION_OFFICER", { mustChangePassword: true })],
  ] as const) {
    it(`${label} → 403, body never read, service never called`, async () => {
      ctx = make();
      bodyReads.count = 0;
      const res = await post(watchedBody());
      expect(res.status).toBe(403);
      expect(bodyReads.count).toBe(0); // no upload slot taken, no byte of the body read by the route
      expect(calls.add).toHaveLength(0);
    });
  }
  it("an Admission Officer passes the gate and the body is read (then the normal checks apply)", async () => {
    ctx = officer();
    bodyReads.count = 0;
    const res = await upload();
    expect(res.status).toBe(201);
    expect(bodyReads.count).toBe(1);
  });
});

