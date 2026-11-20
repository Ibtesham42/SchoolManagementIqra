import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";

/**
 * Phase 4B-M6 — GET /api/v1/academic/report-cards/{id}/pdf: 401 without a session, 404 for malformed ids and for every
 * role without reportcard.generate (refused before any database access), private no-store PDF otherwise (service stubbed).
 */
let ctx: AuthContext | null = null;
vi.mock("@/lib/auth/context", () => ({ getAuthContext: async () => ctx }));
const render = vi.fn();
vi.mock("@/modules/academic/results.service", async (orig) => {
  const real = await orig<typeof import("@/modules/academic/results.service")>();
  return { ...real, renderReportCardPdf: (c: AuthContext, id: string) => (render.getMockImplementation() ? render(c, id) : real.renderReportCardPdf(c, id)) };
});
const { GET } = await import("@/app/api/v1/academic/report-cards/[id]/pdf/route");

function roleCtx(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: "u", username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: false, permissions: buildPermissionMap(rows) };
}
const call = (id: string) => GET(new Request(`http://localhost/api/v1/academic/report-cards/${id}/pdf`), { params: Promise.resolve({ id }) });

describe("report card PDF route", () => {
  beforeEach(() => {
    render.mockReset();
    ctx = null;
  });
  it("401 without a session; 404 for a malformed id", async () => {
    expect((await call("abc")).status).toBe(401);
    ctx = roleCtx("SCHOOL_ADMIN");
    expect((await call("x".repeat(65))).status).toBe(404);
  });
  it("every role without reportcard.generate gets 404 (no oracle), before any database access", async () => {
    const holders = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "CLASS_TEACHER"]);
    for (const role of ROLES) {
      if (holders.has(role.key)) continue;
      ctx = roleCtx(role.key);
      const res = await call("card1");
      expect(res.status, role.key).toBe(404);
    }
  });
  it("serves the rendered PDF privately", async () => {
    ctx = roleCtx("SCHOOL_ADMIN");
    render.mockImplementation(async () => ({ pdf: Buffer.from("%PDF-1.4 test"), fileName: "report-card-Term-1-STU-1.pdf" }));
    const res = await call("card1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});
