import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildPortalContext } from "@/lib/auth/portal-context";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES } from "@/lib/rbac/catalog";
import { portalGrantRows } from "@/lib/auth/portal-context";

// Real PDF renders / first imports of heavy route modules: allow for a loaded machine when the whole suite runs.
vi.setConfig({ testTimeout: 30_000 });

/**
 * Phase 6B-M1 entry condition (KI-107, closing review 6A-M4 M2 c/e) — offline, no database:
 *  1. the redirect matrix: the real `requireAuth` sends a portal account to /portal from every ERP page, layout and
 *     action (each calls it — source scan — or only redirects); staff are sent away from /portal by `requirePortal`;
 *  2. HTTP-level IDOR rows: every /api/v1 route handler, called with a parent / student session, answers 401 / 403 /
 *     404 — never data — and the SAME status and body for the caller's own child and another family's child.
 * Services refuse portal scopes before any database access, so this runs without one (a 500 here would mean a route
 * touched data before refusing).
 */
const OWN = "cownchild00000000000000000";
const OTHER = "cotherfamily00000000000000";

function portalCtx(roleKey: "PARENT" | "STUDENT"): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: false, permissionKey: g.key, scope: g.scope }));
  const kind = roleKey === "PARENT" ? "GUARDIAN" : "STUDENT";
  const portal = buildPortalContext({
    roleKeys: [roleKey],
    guardianId: kind === "GUARDIAN" ? "g1" : null,
    studentId: kind === "STUDENT" ? OWN : null,
    guardian: kind === "GUARDIAN" ? { deletedAt: null, students: [{ portalAccess: true, student: { id: OWN, status: "ACTIVE", deletedAt: null, statusChanges: [] } }] } : null,
    student: kind === "STUDENT" ? { id: OWN, status: "ACTIVE", deletedAt: null, statusChanges: [] } : null,
  });
  return { userId: `u-${roleKey}`, username: roleKey.toLowerCase(), displayName: roleKey, roleKeys: [roleKey], isSuperAdmin: false, permissions: buildPermissionMap(portalGrantRows(rows, kind)), sessionId: "s", portal, mustChangePassword: false, ipHash: "ip" };
}
const staffCtx = (): AuthContext => {
  const role = ROLES.find((r) => r.key === "TEACHER")!;
  const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey: "TEACHER", isSystem: false, permissionKey: g.key, scope: g.scope }));
  return { userId: "u-t", username: "t", displayName: "T", roleKeys: ["TEACHER"], isSuperAdmin: false, permissions: buildPermissionMap(rows), sessionId: "s", portal: null, mustChangePassword: false };
};

let current: AuthContext | null = null;
vi.mock("server-only", () => ({}));
// Review 6B-M1 L2: any database access during a refusal is recorded (a route's catch-all can't hide it).
let dbTouches: string[] = [];
vi.mock("@/lib/db", () => {
  const prisma = new Proxy({}, { get: (_t, prop) => { dbTouches.push(String(prop)); throw new Error(`database touched: ${String(prop)}`); } });
  return { prisma };
});
vi.mock("next/headers", () => ({ cookies: vi.fn(async () => ({ get: () => ({ value: "token" }), set: vi.fn(), delete: vi.fn() })), headers: vi.fn(async () => new Headers()) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error("NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("@/lib/auth/session", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/session")>()), validateSessionToken: vi.fn(async () => current) }));

beforeAll(() => {
  vi.stubEnv("RATE_LIMIT_DRIVER", "memory");
  vi.stubEnv("APP_URL", "http://localhost:3000");
});

// ───────────────────────────── 1. redirect matrix ─────────────────────────────
const ROOT = join(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

describe("redirect matrix", () => {
  it("every ERP page, layout and action calls requireAuth (or only redirects)", () => {
    const files = walk(join(ROOT, "src", "app", "erp")).filter((f) => /[\\/](page|layout)\.tsx$|[\\/][\w-]*actions\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(80);
    const missing = files.filter((f) => {
      const s = readFileSync(f, "utf8");
      // Review 6B-M1 L2: an actual call, comments stripped.
      const code = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/await requireAuth\(/.test(code)) return false;
      const onlyRedirects = /redirect\(/.test(s) && !/@\/modules|prisma/.test(s);
      return !onlyRedirects;
    });
    expect(missing).toEqual([]);
  });

  it("the real requireAuth: portal accounts → /portal (pending change → /portal/change-password); staff pass", async () => {
    const { requireAuth } = await import("@/lib/auth/context");
    for (const kind of ["PARENT", "STUDENT"] as const) {
      current = portalCtx(kind);
      await expect(requireAuth()).rejects.toThrow("REDIRECT:/portal");
      await expect(requireAuth({ allowPendingPasswordChange: true })).rejects.toThrow("REDIRECT:/portal");
      current = { ...portalCtx(kind), mustChangePassword: true };
      await expect(requireAuth({ allowPendingPasswordChange: true })).rejects.toThrow("REDIRECT:/portal/change-password");
    }
    current = staffCtx();
    await expect(requireAuth()).resolves.toMatchObject({ userId: "u-t" });
  });

  it("the real requirePortal: staff → /erp; portal accounts pass", async () => {
    const { requirePortal } = await import("@/lib/auth/context");
    current = staffCtx();
    await expect(requirePortal()).rejects.toThrow("REDIRECT:/erp");
    current = portalCtx("PARENT");
    await expect(requirePortal()).resolves.toMatchObject({ portal: { kind: "GUARDIAN" } });
    current = null;
    await expect(requirePortal()).rejects.toThrow("REDIRECT:/login");
  });
});

// ───────────────────────────── 2. HTTP-level IDOR rows ─────────────────────────────
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
interface Row {
  route: string;
  method: "GET" | "POST";
  /** Route params for the own child / the other family's child (ids not about a student use the same id twice). */
  params: (studentId: string) => Record<string, string>;
  body?: (studentId: string) => string;
}
const ID = "cnotyours00000000000000000";
const ROWS: Row[] = [
  { route: "students/[id]/photo", method: "GET", params: (s) => ({ id: s }) },
  { route: "students/[id]/documents/[docId]", method: "GET", params: (s) => ({ id: s, docId: ID }) },
  { route: "students/export", method: "POST", params: () => ({}), body: (s) => `q=${s}` },
  { route: "academic/report-cards/[id]/pdf", method: "GET", params: (s) => ({ id: s }) },
  { route: "academic/homework/[id]/attachment", method: "GET", params: (s) => ({ id: s }) },
  { route: "academic/homework/[id]/attachment", method: "POST", params: () => ({ id: ID }), body: () => "file=x" },
  { route: "academic/marks/template", method: "POST", params: () => ({}), body: (s) => `marksSheetId=${s}` },
  { route: "admissions/[id]/documents/[docId]", method: "GET", params: (s) => ({ id: s, docId: ID }) },
  { route: "documents/preview", method: "GET", params: () => ({}) },
  { route: "employees/[id]/documents/[docId]", method: "GET", params: () => ({ id: ID, docId: ID }) },
  { route: "employees/[id]/photo", method: "GET", params: () => ({ id: ID }) },
  { route: "employees/export", method: "POST", params: () => ({}), body: () => "q=" },
  { route: "fees/receipts/[id]/pdf", method: "GET", params: (s) => ({ id: s }) },
  // Valid filters, so the permission check itself is exercised (bad filters are refused before it, identically for every id).
  { route: "fees/reports/[name]/export", method: "POST", params: () => ({ name: "defaulters" }), body: () => `academicSessionId=${ID}&minDays=1` },
  { route: "admissions/[id]/documents", method: "POST", params: () => ({ id: ID }), body: () => "type=OTHER" },
  { route: "employees/[id]/documents", method: "POST", params: () => ({ id: ID }), body: () => "type=OTHER" },
  { route: "fees/opening-balances/template", method: "POST", params: () => ({}), body: () => `academicSessionId=${ID}&classId=${ID}&format=csv` },
  { route: "payroll/runs/[id]/export", method: "POST", params: () => ({ id: ID }), body: () => "format=csv" },
  { route: "payroll/slips/[id]/pdf", method: "GET", params: () => ({ id: ID }) },
  { route: "staff-attendance/summary/export", method: "POST", params: () => ({}), body: () => "month=2026-11" },
  { route: "portal-accounts/slips", method: "POST", params: () => ({}), body: (s) => `target=guardian&studentId=${s}&guardianId=g1&mode=reset` },
];

/** Phase 6B-M2: family download routes. A family's own-child request needs the record's owner (database); staff are refused first. */
const PORTAL_ROUTES = ["portal/report-cards/[id]/pdf", "portal/homework/[id]/attachment"];

async function call(row: Row, studentId: string) {
  const mod = (await import(`@/app/api/v1/${row.route}/route`)) as Record<string, Handler>;
  const body = row.body?.(studentId);
  const req = new Request(`http://localhost:3000/api/v1/${row.route}`, {
    method: row.method,
    headers: {
      origin: "http://localhost:3000",
      "sec-fetch-site": "same-origin",
      accept: "application/json",
      ...(body !== undefined ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
    },
    body,
  });
  const res = await mod[row.method](req, { params: Promise.resolve(row.params(studentId)) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}

describe("HTTP-level IDOR rows: every /api/v1 route refuses portal accounts, identically for own and other children", () => {
  it("covers every exported method of every /api/v1 route", () => {
    // Review 6B-M1 L1: route + METHOD, so a new PUT / DELETE can't slip by.
    const found = walk(join(ROOT, "src", "app", "api", "v1"))
      .filter((f) => f.endsWith("route.ts"))
      .flatMap((f) => {
        const route = f.split(/api[\\/]v1[\\/]/)[1].replace(/\\/g, "/").replace(/\/route\.ts$/, "");
        return [...readFileSync(f, "utf8").matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => `${m[1]} ${route}`);
      });
    // The one exclusion: GET files/[id] serves public media and must read the file row before it can tell public from
    // private (missing and forbidden are both 404 there — files.service canReadStoredFile; covered against a database).
    // The portal routes (6B-M2) serve families: they are tested below against staff sessions instead.
    expect(found.filter((r) => r !== "GET files/[id]" && !r.includes(" portal/")).sort()).toEqual(ROWS.map((r) => `${r.method} ${r.route}`).sort());
    expect(found.filter((r) => r.includes(" portal/")).sort()).toEqual(PORTAL_ROUTES.map((r) => `GET ${r}`).sort());
  });

  for (const kind of ["PARENT", "STUDENT"] as const) {
    for (const row of ROWS) {
      it(`${kind} × ${row.method} ${row.route}`, async () => {
        current = portalCtx(kind);
        dbTouches = [];
        const own = await call(row, OWN);
        const other = await call(row, OTHER);
        expect([401, 403, 404], `${row.route}: ${own.status} ${own.body.slice(0, 120)}`).toContain(own.status);
        expect(own.type).not.toMatch(/pdf|csv|spreadsheet|image|octet/);
        expect(other).toEqual(own); // same status, type and body: no oracle
        expect(own.body).not.toContain(OWN);
        expect(dbTouches, "a refusal must come before any database access").toEqual([]);
      });
    }
  }
});

describe("portal download routes refuse every staff session before any database access (identical 404)", () => {
  const staffOf = (roleKey: string): AuthContext => {
    const role = ROLES.find((r) => r.key === roleKey)!;
    const rows = role.grants.map(normalizeGrant).map((g) => ({ roleKey, isSystem: false, permissionKey: g.key, scope: g.scope }));
    return { userId: `u-${roleKey}`, username: roleKey.toLowerCase(), displayName: roleKey, roleKeys: [roleKey], isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), sessionId: "s", portal: null, mustChangePassword: false };
  };
  for (const roleKey of ["SUPER_ADMIN", "PRINCIPAL", "CLASS_TEACHER", "ACCOUNTANT"]) {
    for (const route of PORTAL_ROUTES) {
      it(`${roleKey} × GET ${route}`, async () => {
        current = staffOf(roleKey);
        dbTouches = [];
        const a = await call({ route, method: "GET", params: () => ({ id: OWN }) }, OWN);
        const b = await call({ route, method: "GET", params: () => ({ id: OTHER }) }, OTHER);
        expect(a.status).toBe(404);
        expect(b).toEqual(a);
        expect(dbTouches).toEqual([]);
      });
    }
  }
  it("cross-site requests are refused", async () => {
    current = portalCtx("PARENT");
    const mod = (await import("@/app/api/v1/portal/report-cards/[id]/pdf/route")) as unknown as Record<string, Handler>;
    const res = await mod.GET(new Request("http://localhost:3000/x", { headers: { "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ id: OWN }) });
    expect(res.status).toBe(403);
  });
});
