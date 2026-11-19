import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, RateLimitedError, ValidationError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { REGISTER_HEADER } from "@/modules/payroll/reports.service";

/**
 * Phase 3C-M6 — POST /api/v1/payroll/runs/{id}/export with the service stubbed (CSRF, 401, 429, fixed redirect codes,
 * download headers), plus the real service's permission gates and the register's columns (no PAN / bank).
 */
type Ctx = { userId: string } | null;
let ctx: Ctx = { userId: "u1" };
let rateLimited = false;
let behaviour: () => Promise<unknown> = async () => ({ csv: "﻿Slip no\r\n", month: "2026-10", rows: 0 });
const calls: unknown[][] = [];

vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
vi.mock("@/lib/rate-limit", () => ({
  RULES: { export: { name: "export", limit: 10, windowSeconds: 600 } },
  enforce: async () => {
    if (rateLimited) throw new RateLimitedError();
  },
}));
vi.mock("@/modules/payroll/reports.service", async (orig) => ({
  ...(await orig<typeof import("@/modules/payroll/reports.service")>()),
  exportRunRegister: (...args: unknown[]) => {
    calls.push(args);
    return behaviour();
  },
}));

const { POST } = await import("@/app/api/v1/payroll/runs/[id]/export/route");
const APP = "http://127.0.0.1:3000";
const req = (opts: { headers?: Record<string, string>; html?: boolean } = {}) =>
  POST(
    new Request(`${APP}/api/v1/payroll/runs/run1/export`, {
      method: "POST",
      headers: { origin: APP, host: "127.0.0.1:3000", accept: opts.html ? "text/html" : "application/json", ...opts.headers },
    }),
    { params: Promise.resolve({ id: "run1" }) },
  );

beforeEach(() => {
  ctx = { userId: "u1" };
  rateLimited = false;
  calls.length = 0;
  behaviour = async () => ({ csv: "﻿Slip no\r\n", month: "2026-10", rows: 0 });
});

describe("POST /api/v1/payroll/runs/{id}/export", () => {
  it("returns a private CSV attachment named by month", async () => {
    const r = await req();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="payroll-2026-10.csv"');
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(calls[0][1]).toBe("run1");
  });
  it("CSRF, 401 and 429 are refused before the service", async () => {
    expect((await req({ headers: { origin: "https://evil.example" } })).status).toBe(403);
    ctx = null;
    const html = await req({ html: true });
    expect([html.status, html.headers.get("location")]).toEqual([303, "/login"]);
    ctx = { userId: "u1" };
    rateLimited = true;
    expect((await req()).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
  it("browser posts redirect back to the run with a fixed code only", async () => {
    behaviour = async () => {
      throw new ValidationError("<b>any</b>");
    };
    const r = await req({ html: true });
    expect([r.status, r.headers.get("location")]).toEqual([303, "/erp/payroll/runs/run1?export=invalid"]);
    behaviour = async () => {
      throw new ConflictError("x");
    };
    expect((await req({ html: true })).headers.get("location")).toBe("/erp/payroll/runs/run1?export=too_many");
  });
});

describe("register service gates and columns", () => {
  function roleCtx(roleKey: string): AuthContext {
    const role = ROLES.find((r) => r.key === roleKey)!;
    const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
    return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
  }
  it("needs payroll.read AND export.run: the Principal (no export.run) and teachers are refused", async () => {
    const real = await vi.importActual<typeof import("@/modules/payroll/reports.service")>("@/modules/payroll/reports.service");
    for (const key of ["PRINCIPAL", "TEACHER", "PARENT", "STUDENT"]) {
      await expect(real.exportRunRegister(roleCtx(key), "run1"), key).rejects.toBeInstanceOf(ForbiddenError);
    }
    await expect(real.getRunComponentTotals(roleCtx("TEACHER"), "run1")).rejects.toBeInstanceOf(ForbiddenError);
  });
  it("the register has no PAN, bank or personal columns", () => {
    expect(REGISTER_HEADER.join(" ")).not.toMatch(/PAN|bank|account|IFSC|phone|address|birth/i);
  });
});
