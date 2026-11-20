/**
 * G7 B5 (KI-052): after the forced password change, the ERP navigation kept the "pending change" menu
 * (Dashboard + My account only) until a full reload, because the action redirected without re-rendering
 * the ERP layout. These tests pin both halves: the menu a user gets before/after the change, and that
 * the action re-renders the ERP layout before redirecting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { visibleNavItems } from "@/components/erp/nav-items";
import { ValidationError } from "@/lib/errors";

// ── action dependencies (Next.js runtime + the identity service; no database) ──
const calls: string[] = [];
const changeOwnPassword = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string, type?: string) => calls.push(`revalidatePath:${path}:${type}`) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    calls.push(`redirect:${url}`);
    throw new Error("NEXT_REDIRECT"); // Next's redirect() throws; nothing after it runs
  },
}));
vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/auth/context", () => ({
  requireAuth: vi.fn(async () => ctxFor("SCHOOL_ADMIN", true)),
  clearSessionCookie: vi.fn(),
  clientIpHash: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ revokeSession: vi.fn(), sessionCookieName: () => "sid" }));
vi.mock("@/modules/identity/auth.service", () => ({ login: vi.fn(), loginSchema: z.object({}) }));
vi.mock("@/modules/identity/password.service", () => ({
  changeOwnPassword: (...args: unknown[]) => changeOwnPassword(...args),
  changePasswordSchema: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1), confirmPassword: z.string().min(1) }),
}));

function ctxFor(roleKey: string, mustChangePassword: boolean): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  const permissions = new Map<PermissionKey, Set<Scope>>();
  for (const g of role.grants) {
    const { key, scope } = normalizeGrant(g);
    permissions.set(key, (permissions.get(key) ?? new Set<Scope>()).add(scope));
  }
  return {
    userId: "u1", username: "demo", displayName: "Demo", roleKeys: [roleKey], isSuperAdmin: false,
    permissions, sessionId: "s1", mustChangePassword,
  };
}
const menu = (ctx: AuthContext) => visibleNavItems((p) => hasPermission(ctx, p), (p) => scopeFor(ctx, p)).map((i) => i.label);

describe("B5 — ERP navigation before and after the forced password change", () => {
  it("while the change is pending, only always-visible items show (by design)", () => {
    expect(menu(ctxFor("SCHOOL_ADMIN", true))).toEqual(["Dashboard", "My account"]);
  });

  // Phase 2 (ADR-034) added "Classes" (academic.read), Phase 2B "Admissions" (admission.read) and S7 "Students" (student.read) to the G7 J13/J14 menus;
  // Phase 3A M2 "Staff" (employee.read at ALL).
  it("School Admin after the change: Classes, Users and Settings, no Roles (G7 J13 expectation + Classes)", () => {
    expect(menu(ctxFor("SCHOOL_ADMIN", false))).toEqual(["Dashboard", "Admissions", "Students", "Roll numbers", "Staff", "Staff attendance", "My salary slips", "Fees", "Classes", "Users", "Settings", "My account"]);
  });

  it("Teacher after the change: Classes (own sections), no Users, Roles or Settings (G7 J14 expectation + Classes)", () => {
    expect(menu(ctxFor("TEACHER", false))).toEqual(["Dashboard", "Students", "Leave", "Staff attendance", "My salary slips", "Classes", "My account"]);
  });

  it("Super Admin sees every item", () => {
    expect(menu({ ...ctxFor("SCHOOL_ADMIN", false), isSuperAdmin: true })).toEqual(["Dashboard", "Admissions", "Students", "Roll numbers", "Staff", "Leave", "Staff attendance", "Payroll", "My salary slips", "Fees", "Classes", "Users", "Roles", "Settings", "My account"]);
  });
});

describe("Phase 3A M2 — the Staff menu item", () => {
  it.each([
    ["HR_MANAGER", true],
    ["PRINCIPAL", true],
    ["VICE_PRINCIPAL", true],
    ["LIBRARIAN", true], // Q3: directory only
    ["ACCOUNTANT", false],
    ["ADMISSION_OFFICER", false],
    ["TEACHER", false],
    ["CLASS_TEACHER", false],
    ["TRANSPORT_MANAGER", false],
    ["PARENT", false],
    ["STUDENT", false],
  ])("%s sees Staff: %s", (role, shown) => {
    expect(menu(ctxFor(role, false)).includes("Staff")).toBe(shown);
  });

  it("a SELF-only employee.read grant shows no Staff link (no directory for SELF; M3 adds My profile)", () => {
    const ctx = ctxFor("TEACHER", false);
    ctx.permissions.set("employee.read", new Set<Scope>(["SELF"]));
    expect(menu(ctx).includes("Staff")).toBe(false);
  });
});

describe("B5 — changePasswordAction re-renders the ERP layout before redirecting", () => {
  const form = () => {
    const f = new FormData();
    f.set("currentPassword", "old-synthetic");
    f.set("newPassword", "new-synthetic");
    f.set("confirmPassword", "new-synthetic");
    return f;
  };
  beforeEach(() => {
    calls.length = 0;
    changeOwnPassword.mockReset();
  });

  it("success: revalidatePath('/erp', 'layout') then redirect('/erp')", async () => {
    changeOwnPassword.mockResolvedValue(undefined);
    const { changePasswordAction } = await import("@/app/(auth)/login/actions");
    await expect(changePasswordAction({}, form())).rejects.toThrow("NEXT_REDIRECT");
    expect(changeOwnPassword).toHaveBeenCalledOnce();
    expect(calls).toEqual(["revalidatePath:/erp:layout", "redirect:/erp"]);
  });

  it("service error: no revalidation, no redirect, error returned to the form", async () => {
    changeOwnPassword.mockRejectedValue(new ValidationError("Current password is incorrect."));
    const { changePasswordAction } = await import("@/app/(auth)/login/actions");
    const state = await changePasswordAction({}, form());
    expect(state.error).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it("invalid input: no service call, no revalidation, no redirect", async () => {
    const { changePasswordAction } = await import("@/app/(auth)/login/actions");
    const state = await changePasswordAction({}, new FormData());
    expect(state).toEqual({ error: "Fill in all fields." });
    expect(changeOwnPassword).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});
