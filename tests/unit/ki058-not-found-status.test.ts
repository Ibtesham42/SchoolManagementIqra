import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import { NotFoundError } from "@/lib/errors";
import { scopeFor, hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";

/**
 * KI-058: "not found" ERP pages returned HTTP 200. Cause: `src/app/erp/loading.tsx` wrapped every ERP page in
 * a Suspense boundary, so Next.js streamed the shell (status 200) before the page called notFound(). Fix:
 * no loading boundary above any page that can call notFound() — the page then completes before the first
 * byte and notFound() becomes a real 404.
 *
 * Part 1 (static guard) pins the structural cause for every page that calls notFound().
 * Part 2 runs the real student profile page with only auth and the students service mocked: valid page,
 * unauthenticated (redirect, no data read), authenticated without permission (not-permitted screen — NOT a
 * 404, so access control is unchanged), and a missing / out-of-scope record (notFound → 404, nothing rendered).
 */

// ───────────────────────────── Part 1: static guard ─────────────────────────────

const APP = join(process.cwd(), "src", "app");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = walk(APP);
const LOADING = /(^|[\\/])loading\.(tsx|ts|jsx|js)$/;

describe("KI-058 static guard: no streaming boundary above pages that call notFound()", () => {
  const notFoundPages = files.filter((f) => /[\\/]page\.tsx$/.test(f) && /\bnotFound\(\)/.test(readFileSync(f, "utf8")));

  it("finds the ERP detail pages that call notFound() (the guard is not vacuous)", () => {
    const rel = notFoundPages.map((f) => relative(APP, f).split(sep).join("/")).sort();
    expect(rel).toEqual(
      expect.arrayContaining(["erp/students/[id]/page.tsx", "erp/students/[id]/edit/page.tsx", "erp/students/[id]/status/page.tsx", "erp/admissions/[id]/page.tsx", "erp/users/[id]/page.tsx", "erp/roles/[id]/page.tsx"]),
    );
  });

  it("no loading.* file in any ancestor segment of those pages (a Suspense boundary would commit HTTP 200)", () => {
    const offenders: string[] = [];
    for (const page of notFoundPages) {
      for (let dir = dirname(page); dir.startsWith(APP); dir = dirname(dir)) {
        for (const f of files) if (dirname(f) === dir && LOADING.test(f)) offenders.push(`${relative(APP, f)} (above ${relative(APP, page)})`);
        if (dir === APP) break;
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("no layout wraps its children in <Suspense> (same effect as loading.tsx)", () => {
    const layouts = files.filter((f) => /[\\/]layout\.tsx$/.test(f));
    expect(layouts.length).toBeGreaterThan(0);
    for (const l of layouts) expect(readFileSync(l, "utf8"), relative(APP, l)).not.toMatch(/<Suspense\b/);
  });

  it("the global not-found screen is static: no props, no data access, no params", () => {
    const src = readFileSync(join(APP, "not-found.tsx"), "utf8");
    expect(src).toMatch(/export default function NotFound\(\)/);
    expect(src).not.toMatch(/@\/modules|prisma|params|searchParams|getStudent|await /);
  });
});

// ───────────────────────────── Part 2: the student profile page ─────────────────────────────

let currentCtx: AuthContext | null = null;
const getStudent = vi.fn();

vi.mock("@/lib/auth/context", () => ({
  // Same contract as the real requireAuth: no session → redirect("/login") (throws NEXT_REDIRECT).
  requireAuth: vi.fn(async () => (currentCtx ? currentCtx : redirect("/login"))),
}));
vi.mock("@/modules/students/students.service", () => ({
  canBrowseStudents: (ctx: AuthContext) => {
    const s = hasPermission(ctx, "student.read") ? scopeFor(ctx, "student.read") : null;
    return s === "ALL" || s === "ASSIGNED";
  },
  getStudent: (...args: unknown[]) => getStudent(...args),
}));
// Phase 6A-M3: the "Family access" panel (School Admin) — no database in this unit test.
vi.mock("@/modules/students/family-accounts.service", () => ({ canManageFamilyAccess: () => true, getFamilyAccess: vi.fn(async () => []) }));
vi.mock("@/modules/settings/settings.public", () => ({ getSchoolTimezone: vi.fn(async () => "Asia/Kolkata") }));

const { default: StudentPage } = await import("@/app/erp/students/[id]/page");
const { NotPermitted } = await import("@/components/erp/not-permitted");

function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return { userId: "u1", username: "synthetic", displayName: "Synthetic", roleKeys: [roleKey], isSuperAdmin: false, permissions, sessionId: "s1" };
}

const STUDENT = {
  id: "cmsyntheticstudent01",
  studentCode: "DEMO-2026-0001",
  admissionNo: "ADM-2026-0001",
  firstName: "Synthetic",
  middleName: null,
  lastName: "Pupil",
  fullName: "Synthetic Pupil",
  dob: new Date("2016-05-01T00:00:00Z"),
  gender: "FEMALE",
  phone: null,
  email: null,
  address: null,
  previousSchool: null,
  status: "ACTIVE",
  admissionDate: new Date("2026-06-01T00:00:00Z"),
  version: 1,
  admittedSession: { name: "2026-27" },
  guardians: [{ relation: "MOTHER", isPrimary: true, isEmergencyContact: true, guardian: { id: "g1", name: "Synthetic Parent", phone: "9700000001", altPhone: null, email: null, occupation: null, _count: { students: 1 } } }],
  enrollments: [],
  statusChanges: [],
  hasPhoto: false,
  documents: null,
  application: null,
};

const call = (id = STUDENT.id) => StudentPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
const digestOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { digest?: string }).digest ?? `non-Next error: ${(e as Error).message}`;
  }
};
const markup = (el: unknown) => renderToStaticMarkup(el as ReactElement);

describe("KI-058 regression: student profile page outcomes", () => {
  beforeEach(() => {
    currentCtx = null;
    getStudent.mockReset();
  });

  it("valid page (School Admin, existing student): renders the profile", async () => {
    currentCtx = ctxFor("SCHOOL_ADMIN");
    getStudent.mockResolvedValue(STUDENT);
    const el = await call();
    expect(isValidElement(el)).toBe(true);
    const html = markup(el);
    expect(html).toContain("Synthetic Pupil");
    expect(html).toContain("DEMO-2026-0001");
    expect(getStudent).toHaveBeenCalledWith(currentCtx, STUDENT.id);
  });

  it("unauthenticated: redirect to /login (HTTP 307), no student data read", async () => {
    const digest = await digestOf(call());
    expect(digest).toMatch(/^NEXT_REDIRECT;replace;\/login;307;/);
    expect(getStudent).not.toHaveBeenCalled();
  });

  it("authenticated but unauthorized (Parent — student.read CHILDREN only): the not-permitted screen, NOT a 404; no data read", async () => {
    currentCtx = ctxFor("PARENT");
    const el = await call();
    expect(isValidElement(el) && (el as ReactElement).type).toBe(NotPermitted);
    expect(markup(el)).toContain("You don&#x27;t have access to this page");
    expect(getStudent).not.toHaveBeenCalled();
  });

  it("authenticated, record does not exist: notFound() → HTTP 404, nothing rendered", async () => {
    currentCtx = ctxFor("SCHOOL_ADMIN");
    getStudent.mockRejectedValue(new NotFoundError("Student not found."));
    expect(await digestOf(call("cmdoesnotexist000001"))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("authenticated class teacher, student of another section: the same 404 as a missing record (no existence oracle)", async () => {
    currentCtx = ctxFor("CLASS_TEACHER");
    getStudent.mockRejectedValue(new NotFoundError("Student not found.")); // the service's scope filter refuses it
    expect(await digestOf(call())).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
  });

  it("other service errors are not turned into 404 (they surface as errors)", async () => {
    currentCtx = ctxFor("SCHOOL_ADMIN");
    getStudent.mockRejectedValue(new Error("database unavailable"));
    expect(await digestOf(call())).toBe("non-Next error: database unavailable");
  });

  it("the not-found screen itself carries no student data", () => {
    // Rendered for every notFound(): static text only.
    return import("@/app/not-found").then(({ default: NotFoundPage }) => {
      const html = renderToStaticMarkup(createElement(NotFoundPage));
      expect(html).toContain("Page not found");
      expect(html).not.toMatch(/Synthetic|DEMO-2026|ADM-2026|9700000001/);
    });
  });
});
