import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, RateLimitedError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { UPLOAD_RULES } from "@/lib/storage/upload-rules";
import { employeeDocumentFieldsSchema, EMPLOYEE_DOCUMENT_TYPES } from "@/modules/hr/hr.schemas";

/**
 * Phase 3A M4b — staff document routes: upload (CSRF, S-01 gate BEFORE the body is read, fixed redirect codes),
 * download and photo (404 for missing and forbidden alike). The HR documents service, the session lookup and the
 * rate limiter are stubs; Prisma is not mocked — database behaviour is in tests/integration/hr-documents.test.ts.
 */
function ctxFor(roleKey: string, over: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "synthetic", displayName: "Synthetic", roleKeys: [roleKey], isSuperAdmin: false, permissions, sessionId: "s1", ...over };
}
let ctx: AuthContext | null = ctxFor("HR_MANAGER");
let rateLimited = false;
let readBehaviour: () => Promise<unknown> = async () => {
  throw new NotFoundError();
};
const calls = { add: 0 };
const bodyReads = { count: 0 };

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/http/upload", async (orig) => {
  const o = await orig<typeof import("@/lib/http/upload")>();
  return {
    ...o,
    readBodyWithLimit: (...args: Parameters<typeof o.readBodyWithLimit>) => {
      bodyReads.count++;
      return o.readBodyWithLimit(...args);
    },
  };
});
vi.mock("@/lib/rate-limit", () => ({
  RULES: { upload: { name: "upload", limit: 30, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/hr/employee-documents.service", () => ({
  addEmployeeDocument: async () => {
    calls.add++;
    return { id: "doc1", type: "RESUME" };
  },
  readEmployeeDocument: () => readBehaviour(),
  readEmployeePhoto: () => readBehaviour(),
}));

const { POST } = await import("@/app/api/v1/employees/[id]/documents/route");
const { GET: docGet } = await import("@/app/api/v1/employees/[id]/documents/[docId]/route");
const { GET: photoGet } = await import("@/app/api/v1/employees/[id]/photo/route");

const APP = "http://127.0.0.1:3000";
const EMP = "cmemployee000001";
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF"));

async function upload(opts: { headers?: Record<string, string>; html?: boolean; id?: string; fields?: Record<string, string> } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? { type: "RESUME", label: "" })) fd.append(k, v);
  fd.append("file", new Blob([PDF as unknown as BlobPart]), "cv.pdf");
  const r = new Request(APP, { method: "POST", body: fd });
  const bytes = new Uint8Array(await r.arrayBuffer());
  const headers: Record<string, string> = {
    origin: APP,
    host: "127.0.0.1:3000",
    "content-type": r.headers.get("content-type")!,
    "content-length": String(bytes.byteLength),
    accept: opts.html ? "text/html,application/xhtml+xml" : "application/json",
    ...opts.headers,
  };
  return POST(new Request(`${APP}/api/v1/employees/${opts.id ?? EMP}/documents`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({ id: opts.id ?? EMP }) });
}

beforeEach(() => {
  ctx = ctxFor("HR_MANAGER");
  rateLimited = false;
  calls.add = 0;
  bodyReads.count = 0;
  readBehaviour = async () => {
    throw new NotFoundError();
  };
});

describe("POST /api/v1/employees/:id/documents", () => {
  it("HR Manager uploads (201); browser posts go back to the profile with a fixed code", async () => {
    expect((await upload()).status).toBe(201);
    const r = await upload({ html: true });
    expect([r.status, r.headers.get("location")]).toEqual([303, `/erp/hr/employees/${EMP}?upload=ok#documents`]);
  });

  it("S-01: roles without manage + directory + personal tier are refused BEFORE the body is read", async () => {
    for (const role of ["LIBRARIAN", "PRINCIPAL", "TEACHER", "ACCOUNTANT", "PARENT"]) {
      ctx = ctxFor(role, { employeeId: EMP });
      expect((await upload()).status, role).toBe(403);
    }
    expect(bodyReads.count).toBe(0);
    expect(calls.add).toBe(0);
  });

  it("CSRF: cross-site requests are refused before the session; 401 without a session; 429 rate limited", async () => {
    expect((await upload({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    ctx = null;
    expect((await upload()).status).toBe(401);
    ctx = ctxFor("HR_MANAGER");
    rateLimited = true;
    expect((await upload()).status).toBe(429);
    expect(calls.add).toBe(0);
  });

  it("malformed ids and invalid fields are refused; no service call", async () => {
    expect((await upload({ id: "../x" })).status).toBe(404);
    expect((await upload({ fields: { type: "AADHAAR", label: "" } })).status).toBe(422);
    expect(calls.add).toBe(0);
  });
});

describe("GET staff document / photo", () => {
  it("401 without a session; missing and forbidden both 404 (no existence oracle)", async () => {
    ctx = null;
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: EMP }) })).status).toBe(401);
    ctx = ctxFor("LIBRARIAN");
    expect((await docGet(new Request(APP), { params: Promise.resolve({ id: EMP, docId: "abcdef0123456789abcdef0123456789" }) })).status).toBe(404);
    readBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: EMP }) })).status).toBe(404);
    expect((await docGet(new Request(APP), { params: Promise.resolve({ id: "../x", docId: "abc" }) })).status).toBe(404);
  });

  it("PDFs download as sandboxed attachments; photos inline; never cached", async () => {
    readBehaviour = async () => ({ bytes: PDF, mimeType: "application/pdf", originalName: "cv.pdf" });
    const d = await docGet(new Request(APP), { params: Promise.resolve({ id: EMP, docId: "abcdef0123456789abcdef0123456789" }) });
    expect(d.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(d.headers.get("content-security-policy")).toBe("sandbox");
    expect(d.headers.get("cache-control")).toBe("private, no-store");
    readBehaviour = async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: "image/jpeg", originalName: "photo.jpg" });
    expect((await photoGet(new Request(APP), { params: Promise.resolve({ id: EMP }) })).headers.get("content-disposition")).toMatch(/^inline/);
  });
});

describe("staff upload purposes and document types", () => {
  it("documents need the personal tier to read; the photo is directory data; both PRIVATE, managed by employee.document.manage", () => {
    expect(UPLOAD_RULES["employee.document"]).toMatchObject({ visibility: "PRIVATE", uploadPermission: "employee.document.manage", readPermission: "employee.personal.read", ownerType: "EmployeeDocument" });
    expect(UPLOAD_RULES["employee.photo"]).toMatchObject({ visibility: "PRIVATE", uploadPermission: "employee.document.manage", readPermission: "employee.read", allowed: ["image/jpeg"] });
  });
  it("H5: no identity-document types; OTHER needs a description; strict", () => {
    expect(EMPLOYEE_DOCUMENT_TYPES.join(" ")).not.toMatch(/AADHAAR|PAN|PASSPORT|VOTER|BANK/);
    expect(employeeDocumentFieldsSchema.safeParse({ type: "OTHER", label: " " }).success).toBe(false);
    expect(employeeDocumentFieldsSchema.parse({ type: "OTHER", label: " Training  certificate " })).toEqual({ type: "OTHER", label: "Training certificate" });
    expect(employeeDocumentFieldsSchema.safeParse({ type: "RESUME", label: "", employeeId: "x" }).success).toBe(false);
  });
});
