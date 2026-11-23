import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { sessionCookieName, validateSessionToken } from "@/lib/auth/session";
import { hashIdentifier } from "@/lib/crypto";
import { pickClientIp } from "@/lib/auth/client-ip";
import type { AuthContext, PortalContext } from "@/lib/rbac/authorize";
import { homePathFor, type AccountKind } from "@/lib/rbac/account-kind";

/** Per-request cached session lookup for Server Components, actions and route handlers. */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (!token) return null;
  const ctx = await validateSessionToken(token);
  if (!ctx) return null;
  return { ...ctx, ipHash: await clientIpHash() };
});

export const accountKind = (ctx: AuthContext): AccountKind => ctx.portal?.kind ?? "STAFF";

/** Where this account belongs (its shell's home, or its change-password page while a change is pending). */
export const homePath = (ctx: AuthContext) => homePathFor(accountKind(ctx), !!ctx.mustChangePassword);

/**
 * Every ERP page and action calls this (layouts alone are not enough: Next.js does not
 * re-run layouts on client-side navigation, and actions bypass layouts entirely).
 * Users with a pending forced password change are sent to the change-password page
 * unless the caller explicitly opts in (only that page and its action do).
 * Phase 6A-M2 (ADR-045): portal accounts never use the ERP — they are sent to /portal. Only callers shared by both
 * shells (the change-password action) pass `allowPortal`.
 */
export async function requireAuth(opts: { allowPendingPasswordChange?: boolean; allowPortal?: boolean } = {}): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (ctx.portal && !opts.allowPortal) redirect(homePath(ctx));
  if (ctx.mustChangePassword && !opts.allowPendingPasswordChange) redirect(homePath(ctx));
  return ctx;
}

/** A portal-only account's context (narrowed: `portal` is set). */
export type PortalAuthContext = AuthContext & { portal: PortalContext };

/**
 * Every /portal page and portal action calls this (same reasons as requireAuth). Staff accounts go to /erp; a
 * pending password change goes to /portal/change-password unless the caller opts in.
 */
export async function requirePortal(opts: { allowPendingPasswordChange?: boolean } = {}): Promise<PortalAuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  if (!ctx.portal) redirect(homePath(ctx));
  if (ctx.mustChangePassword && !opts.allowPendingPasswordChange) redirect(homePath(ctx));
  return ctx as PortalAuthContext;
}

export async function clientIpHash(): Promise<string> {
  const h = await headers();
  const hops = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return hashIdentifier(pickClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"), hops));
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    // Secure whenever the app is served over HTTPS. Production boot refuses a non-HTTPS
    // APP_URL except localhost (lib/env), so real deployments always get Secure cookies.
    secure: (process.env.APP_URL ?? "").startsWith("https://"),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(sessionCookieName());
}
