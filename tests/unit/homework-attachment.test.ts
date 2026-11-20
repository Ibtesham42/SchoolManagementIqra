import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, NotFoundError, RateLimitedError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { HOMEWORK_UPLOAD_MESSAGES } from "@/lib/http/upload-errors";
import { UPLOAD_RULES } from "@/lib/storage/upload-rules";

/**
 * Phase 4C (KI-094) — homework attachment route: upload (CSRF, permission gate BEFORE the body is read, fixed redirect
 * codes), download (404 for missing and forbidden alike) and the upload rule. The homework service, the session
 * lookup and the rate limiter are stubs; database behaviour is in tests/integration/academic-phase4c.test.ts.
 */
function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "synthetic", displayName: "Synthetic", roleKeys: [roleKey], isSuperAdmin: false, permissions, sessionId: "s1" };
}
let ctx: AuthContext | null = ctxFor("TEACHER");
let rateLimited = false;
let attachBehaviour: () => Promise<void> = async () => undefined;
let readBehaviour: () => Promise<unknown> = async () => {
  throw new NotFoundError();
};
const calls = { attach: 0, read: 0, bodyReads: 0 };

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/http/upload", async (orig) => {
  const o = await orig<typeof import("@/lib/http/upload")>();
  return {
    ...o,
    readBodyWithLimit: (...args: Parameters<typeof o.readBodyWithLimit>) => {
      calls.bodyReads++;
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
vi.mock("@/modules/academic/homework.service", () => ({
  attachHomeworkFile: async () => {
    calls.attach++;
    return attachBehaviour();
  },
  readHomeworkAttachment: () => {
    calls.read++;
    return readBehaviour();
  },
}));

const { POST, GET } = await import("@/app/api/v1/academic/homework/[id]/attachment/route");

const APP = "http://127.0.0.1:3000";
const HW = "cmhomework000001";
const SEC = "cmsection0000001";
const PDF = new Uint8Array(Buffer.from("%PDF-1.7\n%%EOF"));

async function upload(opts: { headers?: Record<string, string>; html?: boolean; id?: string; fields?: Record<string, string> } = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(opts.fields ?? { version: "3", section: SEC })) fd.append(k, v);
  fd.append("file", new Blob([PDF as unknown as BlobPart]), "sheet.pdf");
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
  const id = opts.id ?? HW;
  return POST(new Request(`${APP}/api/v1/academic/homework/${id}/attachment`, { method: "POST", headers, body: bytes }), { params: Promise.resolve({ id }) });
}
const download = (id = HW) => GET(new Request(`${APP}/api/v1/academic/homework/${id}/attachment`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  ctx = ctxFor("TEACHER");
  rateLimited = false;
  calls.attach = 0;
  calls.read = 0;
  calls.bodyReads = 0;
  attachBehaviour = async () => undefined;
  readBehaviour = async () => {
    throw new NotFoundError();
  };
});

describe("homework attachment upload rule", () => {
  it("private, encrypted-by-rule, owned by Homework; every manager can also read", () => {
    const rule = UPLOAD_RULES["homework.attachment"];
    expect(rule).toMatchObject({ visibility: "PRIVATE", ownerType: "Homework", uploadPermission: "homework.manage", readPermission: "academic.read", maxBytes: 10 * 1024 * 1024 });
    expect([...rule.allowed].sort()).toEqual(["application/pdf", "image/jpeg", "image/png"]);
    for (const role of ROLES) {
      const keys = new Set(role.grants.map(normalizeGrant).map((g) => g.key));
      if (keys.has("homework.manage")) expect(keys.has("academic.read"), role.key).toBe(true);
    }
  });
});

describe("POST /api/v1/academic/homework/:id/attachment", () => {
  it("stores through the service; browser posts return to the section with a fixed code", async () => {
    expect((await upload()).status).toBe(201);
    expect(calls.attach).toBe(1);
    const res = await upload({ html: true });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/erp/academic/homework?section=${SEC}&upload=ok`);
  });
  it("cross-site and signed-out posts are refused without reading the body", async () => {
    expect((await upload({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    ctx = null;
    expect((await upload()).status).toBe(401);
    expect((await upload({ html: true })).headers.get("location")).toBe("/login");
    expect(calls.bodyReads).toBe(0);
    expect(calls.attach).toBe(0);
  });
  it("every role without homework.manage is refused BEFORE the body is read", async () => {
    for (const role of ROLES) {
      if (role.grants.map(normalizeGrant).some((g) => g.key === "homework.manage")) continue;
      ctx = ctxFor(role.key);
      expect((await upload()).status, role.key).toBe(403);
    }
    expect(calls.bodyReads).toBe(0);
    expect(calls.attach).toBe(0);
  });
  it("rate limit, bad ids, stale versions and missing homework map to fixed codes", async () => {
    rateLimited = true;
    expect((await upload()).status).toBe(429);
    rateLimited = false;
    expect((await upload({ id: "../x" })).status).toBe(404);
    expect((await upload({ fields: { version: "x" } })).status).toBe(422);
    attachBehaviour = async () => {
      throw new ConflictError("changed");
    };
    expect((await upload({ html: true })).headers.get("location")).toBe(`/erp/academic/homework?section=${SEC}&upload=closed`);
    attachBehaviour = async () => {
      throw new NotFoundError("Homework not found.");
    };
    const res = await upload();
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe(HOMEWORK_UPLOAD_MESSAGES.not_found);
    // A tampered section value never reaches the redirect.
    expect((await upload({ html: true, fields: { version: "3", section: "https://evil.example/" } })).headers.get("location")).toBe("/erp/academic/homework?upload=not_found");
  });
});

describe("GET /api/v1/academic/homework/:id/attachment", () => {
  it("401 signed out; 404 for bad ids, missing and forbidden alike; private download otherwise", async () => {
    ctx = null;
    expect((await download()).status).toBe(401);
    ctx = ctxFor("TEACHER");
    expect((await download("x")).status).toBe(404);
    expect(calls.read).toBe(0);
    expect((await download()).status).toBe(404);
    readBehaviour = async () => ({ bytes: Buffer.from(PDF), mimeType: "application/pdf", originalName: "sheet.pdf" });
    const res = await download();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
  });
});
