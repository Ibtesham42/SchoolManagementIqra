import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, RateLimitedError } from "@/lib/errors";

/**
 * Route-level tests for the S7 student routes: CSV export (same-origin POST, rate limit, small form body,
 * fixed redirect codes, download headers) and the scoped photo/document downloads (404 for missing and
 * forbidden alike). The students service, the session lookup and the DB-backed rate limiter are stubs;
 * the service's database behaviour is covered by tests/integration (pending the Test branch).
 */
type Ctx = { userId: string } | null;
let ctx: Ctx = { userId: "u1" };
let rateLimited = false;
let exportBehaviour: (args: unknown[]) => Promise<unknown> = async () => ({ csv: "﻿Student ID\r\n", rows: 0 });
let readBehaviour: () => Promise<unknown> = async () => {
  throw new NotFoundError();
};
const calls: { export: unknown[][] } = { export: [] };

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/rate-limit", () => ({
  RULES: { export: { name: "export", limit: 10, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/students/students.service", () => ({
  exportStudentRows: (...args: unknown[]) => {
    calls.export.push(args);
    return exportBehaviour(args);
  },
  readStudentPhoto: () => readBehaviour(),
  readStudentDocument: () => readBehaviour(),
}));

const { POST: exportPost } = await import("@/app/api/v1/students/export/route");
const { GET: photoGet } = await import("@/app/api/v1/students/[id]/photo/route");
const { GET: docGet } = await import("@/app/api/v1/students/[id]/documents/[docId]/route");

const APP = "http://127.0.0.1:3000";
const STUDENT = "cmstudent00001";

function exportRequest(opts: { body?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const body = opts.body ?? "session=cmsession00001&status=ACTIVE";
  const headers: Record<string, string> = {
    origin: APP,
    host: "127.0.0.1:3000",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)),
    accept: opts.html ? "text/html,application/xhtml+xml" : "application/json",
    ...opts.headers,
  };
  return exportPost(new Request(`${APP}/api/v1/students/export`, { method: "POST", headers, body }));
}

beforeEach(() => {
  ctx = { userId: "u1" };
  rateLimited = false;
  calls.export = [];
  exportBehaviour = async () => ({ csv: "﻿Student ID\r\n", rows: 0 });
  readBehaviour = async () => {
    throw new NotFoundError();
  };
});

describe("POST /api/v1/students/export", () => {
  it("returns a CSV attachment, never cached, with the parsed filters passed to the service", async () => {
    const r = await exportRequest();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="students-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.export[0][1]).toEqual({ academicSessionId: "cmsession00001", status: "ACTIVE" });
  });
  it("refuses cross-site and Origin-less requests before touching the session or service (CSRF)", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const r = await exportRequest({ headers });
      expect(r.status).toBe(403);
    }
    expect(calls.export).toHaveLength(0);
  });
  it("401 without a session; browser posts go to /login", async () => {
    ctx = null;
    expect((await exportRequest()).status).toBe(401);
    const html = await exportRequest({ html: true });
    expect(html.status).toBe(303);
    expect(html.headers.get("location")).toBe("/login");
  });
  it("429 when rate-limited", async () => {
    rateLimited = true;
    expect((await exportRequest()).status).toBe(429);
    expect(calls.export).toHaveLength(0);
  });
  it("refuses large or non-form bodies and invalid filters (422 ValidationError)", async () => {
    expect((await exportRequest({ body: `q=${"a".repeat(5000)}` })).status).toBe(422);
    expect((await exportRequest({ headers: { "content-type": "application/json" } })).status).toBe(422);
    expect((await exportRequest({ body: "status=DELETED" })).status).toBe(422);
    expect((await exportRequest({ body: "page=2" })).status).toBe(200); // unknown form fields are ignored, never forwarded
    expect(calls.export.at(-1)?.[1]).toEqual({});
  });
  it("403 when the service refuses (e.g. the Accountant, D8); 409 when too many rows", async () => {
    exportBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await exportRequest()).status).toBe(403);
    exportBehaviour = async () => {
      throw new ConflictError("too many");
    };
    const r = await exportRequest();
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("too_many");
  });
  it("browser posts that fail redirect to the directory with a FIXED code only", async () => {
    exportBehaviour = async () => {
      throw new ConflictError("<b>any text</b>");
    };
    const r = await exportRequest({ html: true });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/erp/students?export=too_many");
  });
});

describe("GET student photo / document", () => {
  it("401 without a session", async () => {
    ctx = null;
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: STUDENT }) })).status).toBe(401);
  });
  it("missing and forbidden both look like 404 (no existence oracle); malformed ids too", async () => {
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: STUDENT }) })).status).toBe(404);
    readBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: STUDENT }) })).status).toBe(404);
    expect((await docGet(new Request(APP), { params: Promise.resolve({ id: STUDENT, docId: "abcdef0123456789" }) })).status).toBe(404);
    expect((await docGet(new Request(APP), { params: Promise.resolve({ id: "../x", docId: "abcdef0123456789" }) })).status).toBe(404);
  });
  it("serves the photo inline and a PDF as a sandboxed attachment, never cached", async () => {
    readBehaviour = async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", originalName: "photo.jpg" });
    const p = await photoGet(new Request(APP), { params: Promise.resolve({ id: STUDENT }) });
    expect(p.status).toBe(200);
    expect(p.headers.get("content-disposition")).toMatch(/^inline/);
    expect(p.headers.get("cache-control")).toBe("private, no-store");
    readBehaviour = async () => ({ bytes: new Uint8Array([37, 80, 68, 70]), mimeType: "application/pdf", originalName: "bc.pdf" });
    const d = await docGet(new Request(APP), { params: Promise.resolve({ id: STUDENT, docId: "abcdef0123456789" }) });
    expect(d.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(d.headers.get("content-security-policy")).toBe("sandbox");
  });
  it("other failures are 503 without details", async () => {
    readBehaviour = async () => {
      throw new Error("disk error at /secret/path");
    };
    const r = await photoGet(new Request(APP), { params: Promise.resolve({ id: STUDENT }) });
    expect(r.status).toBe(503);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
  });
});
