import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, RateLimitedError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { STAFF_EXPORT_HEADER } from "@/modules/hr/hr.rules";

/**
 * Phase 3A M5 — POST /api/v1/employees/export (same-origin POST, rate limit, small form body, fixed redirect codes,
 * download headers) with the service stubbed, plus the real export service's permission gates (refused before any
 * database access). Database behaviour: tests/integration/hr-dashboard.test.ts.
 */
type Ctx = { userId: string } | null;
let ctx: Ctx = { userId: "u1" };
let rateLimited = false;
let exportBehaviour: (args: unknown[]) => Promise<unknown> = async () => ({ csv: "﻿Employee ID\r\n", rows: 0 });
const calls: { export: unknown[][] } = { export: [] };

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/rate-limit", () => ({
  RULES: { export: { name: "export", limit: 10, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/hr/employees.service", async (orig) => ({
  ...(await orig<typeof import("@/modules/hr/employees.service")>()),
  exportEmployeeRows: (...args: unknown[]) => {
    calls.export.push(args);
    return exportBehaviour(args);
  },
}));

const { POST } = await import("@/app/api/v1/employees/export/route");
const APP = "http://127.0.0.1:3000";

function exportRequest(opts: { body?: string; headers?: Record<string, string>; html?: boolean } = {}) {
  const body = opts.body ?? "type=TEACHING&status=ACTIVE&q=Asha";
  const headers: Record<string, string> = {
    origin: APP,
    host: "127.0.0.1:3000",
    "content-type": "application/x-www-form-urlencoded",
    "content-length": String(Buffer.byteLength(body)),
    accept: opts.html ? "text/html,application/xhtml+xml" : "application/json",
    ...opts.headers,
  };
  return POST(new Request(`${APP}/api/v1/employees/export`, { method: "POST", headers, body }));
}

beforeEach(() => {
  ctx = { userId: "u1" };
  rateLimited = false;
  calls.export = [];
  exportBehaviour = async () => ({ csv: "﻿Employee ID\r\n", rows: 0 });
});

describe("POST /api/v1/employees/export", () => {
  it("returns a CSV attachment, never cached, with the mapped filters passed to the service", async () => {
    const r = await exportRequest();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="staff-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(calls.export[0][1]).toEqual({ staffType: "TEACHING", status: "ACTIVE", q: "Asha" });
  });
  it("refuses cross-site and Origin-less requests before touching the session or service (CSRF)", async () => {
    for (const headers of [{ origin: "https://evil.example" }, { origin: "" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      expect((await exportRequest({ headers })).status).toBe(403);
    }
    expect(calls.export).toHaveLength(0);
  });
  it("401 without a session (browser → /login); 429 when rate-limited", async () => {
    ctx = null;
    expect((await exportRequest()).status).toBe(401);
    const html = await exportRequest({ html: true });
    expect([html.status, html.headers.get("location")]).toEqual([303, "/login"]);
    ctx = { userId: "u1" };
    rateLimited = true;
    expect((await exportRequest()).status).toBe(429);
    expect(calls.export).toHaveLength(0);
  });
  it("refuses large or non-form bodies and invalid filters; unknown fields are never forwarded", async () => {
    expect((await exportRequest({ body: `q=${"a".repeat(5000)}` })).status).toBe(422);
    expect((await exportRequest({ headers: { "content-type": "application/json" } })).status).toBe(422);
    expect((await exportRequest({ body: "status=DELETED" })).status).toBe(422);
    expect((await exportRequest({ body: "personalPhone=9876543210&page=2" })).status).toBe(200);
    expect(calls.export.at(-1)?.[1]).toEqual({});
  });
  it("403 / 409 from the service; browser posts redirect with a FIXED code only", async () => {
    exportBehaviour = async () => {
      throw new ForbiddenError();
    };
    expect((await exportRequest()).status).toBe(403);
    exportBehaviour = async () => {
      throw new ConflictError("<b>any text</b>");
    };
    const r = await exportRequest({ html: true });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/erp/hr/employees?export=too_many"]);
  });
});

describe("staff export service gates (real service; refused before any database access)", () => {
  function roleCtx(roleKey: string): AuthContext {
    const role = ROLES.find((r) => r.key === roleKey)!;
    const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
    return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows), employeeId: "me" };
  }
  it("needs export.run AND the directory: Librarian (no export.run) and Accountant (export.run, own record only) → 403", async () => {
    const real = await vi.importActual<typeof import("@/modules/hr/employees.service")>("@/modules/hr/employees.service");
    await expect(real.exportEmployeeRows(roleCtx("LIBRARIAN"), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(real.exportEmployeeRows(roleCtx("ACCOUNTANT"), {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(real.exportEmployeeRows(roleCtx("TEACHER"), {})).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("the export header holds directory fields only — no personal-tier column", () => {
    expect([...STAFF_EXPORT_HEADER]).toEqual(["Employee ID", "Name", "Staff type", "Designation", "Department", "Status", "Work phone", "Work email"]);
    expect(STAFF_EXPORT_HEADER.join(" ")).not.toMatch(/birth|dob|personal|address|emergency|appointment|joining|leaving|reason|gender/i);
  });
});
