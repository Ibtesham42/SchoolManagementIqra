import { hasPermission, scopeFor, type AuthContext } from "@/lib/rbac/authorize";
import type { NoticeAudience, NoticeScope } from "./notices.schemas";

/**
 * Phase 6C-M1 (P22) — who may write a notice where, and what readers see. Pure (unit tested).
 *
 * - `notice.manage` ALL (School Admin, Principal; Super Admin): any audience, any scope.
 * - `notice.manage` ASSIGNED (Class Teacher): FAMILIES of SECTIONS they are class teacher of, and only while each of
 *   those sections is theirs in a session that isn't CLOSED. The same test — plus authorship (review 6C-M1 H1: never
 *   the Principal's or another teacher's notice to the same section) — decides whether they may still edit, publish,
 *   withdraw or see the receipts of a notice (a teacher moved to another section loses the old notices).
 * - Portal accounts never manage notices (catalog invariant; refused here too).
 */
export type ManageScope = "ALL" | "ASSIGNED";

export function manageScopeOf(ctx: AuthContext): ManageScope | null {
  if (ctx.portal || !hasPermission(ctx, "notice.manage")) return null;
  const s = scopeFor(ctx, "notice.manage");
  return s === "ALL" || s === "ASSIGNED" ? s : null;
}

export interface NoticeShape {
  audience: NoticeAudience;
  scope: NoticeScope;
  /** Who wrote it (for a new notice: the caller). */
  createdById: string | null;
  /** For SECTION notices: each target section's class teacher (user id) and whether its session is CLOSED. */
  sections: readonly { classTeacherId: string | null; sessionClosed: boolean }[];
}

export function mayWriteNotice(scope: ManageScope | null, userId: string, n: NoticeShape): boolean {
  if (scope === "ALL") return true;
  if (scope !== "ASSIGNED") return false;
  return n.createdById === userId && n.audience === "FAMILIES" && n.scope === "SECTION" && n.sections.length > 0 && n.sections.every((s) => s.classTeacherId === userId && !s.sessionClosed);
}

/** Staff read STAFF and ALL notices; families read FAMILIES and ALL notices. */
export const STAFF_AUDIENCES: NoticeAudience[] = ["STAFF", "ALL"];
export const FAMILY_AUDIENCES: NoticeAudience[] = ["FAMILIES", "ALL"];

export type NoticeState = "DRAFT" | "SCHEDULED" | "LIVE" | "EXPIRED" | "WITHDRAWN";

/**
 * `sessionEnd` / `today` (school-local YYYY-MM-DD): a notice without "show until" ends with its academic session
 * (owner decision 2026-11-24, review 6C-M1 I1) — no whole-school notice lingers across sessions.
 */
export function noticeState(n: { status: "DRAFT" | "PUBLISHED" | "WITHDRAWN"; publishAt: Date | null; expiresAt: Date | null; sessionEnd: string }, now: Date, today: string): NoticeState {
  if (n.status === "DRAFT") return "DRAFT";
  if (n.status === "WITHDRAWN") return "WITHDRAWN";
  if (n.publishAt && n.publishAt > now) return "SCHEDULED";
  if (n.expiresAt ? n.expiresAt <= now : n.sessionEnd < today) return "EXPIRED";
  return "LIVE";
}

/** Prisma filter: published, already visible, not expired ("show until", or else the session's last day). */
export function liveWhere(now: Date, today: string) {
  return {
    status: "PUBLISHED" as const,
    publishAt: { lte: now },
    OR: [{ expiresAt: { gt: now } }, { expiresAt: null, academicSession: { endDate: { gte: new Date(`${today}T00:00:00.000Z`) } } }],
  };
}

/**
 * Publishing: a planned time in the past (or none) means now; the expiry must still be after it.
 * Returns the instant readers start seeing the notice, or an error message.
 */
export function publishMoment(planned: Date | null, expiresAt: Date | null, now: Date): { publishAt: Date } | { error: string } {
  const publishAt = planned && planned > now ? planned : now;
  if (expiresAt && expiresAt <= publishAt) return { error: "The notice would expire before it is shown. Change “Show until” first." };
  return { publishAt };
}
