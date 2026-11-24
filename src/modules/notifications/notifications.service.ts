import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { AuthContext } from "@/lib/rbac/authorize";

/**
 * Phase 6C-M2 — in-app notifications (PHASE_6_PLAN.md P23, ADR-047). Owns `Notification`; depends on no domain module.
 *
 * - Domain services build drafts AFTER their transaction committed and hand them to `afterCommit` (backend rule:
 *   never inside the transaction), so a rolled-back write sends nothing. Delivery failures are logged by name and never
 *   fail the business operation that already committed.
 * - Idempotent: every draft carries a dedupe key ("absence:<student>:<date>"); the partial unique (user_id,
 *   dedupe_key) + `skipDuplicates` make retries and re-marks no-ops. Bounded: `createMany` in batches of 500, at most
 *   20,000 rows per call.
 * - In-app only (P23: no email, SMS or WhatsApp for events). Bodies carry no sensitive data — a first name and what
 *   happened, never marks, amounts, reasons or references.
 * - Links are portal paths built by the callers; opening one is a POST (server action) that marks it read and
 *   redirects only to a `/portal/` path.
 * - Readers see only their own rows (userId = ctx.userId); anything else is NotFound. Retention: 90 days
 *   (lib/maintenance cleanup).
 */
export type NotificationType = "result.published" | "attendance.absent" | "fee.receipt" | "fee.receipt_cancelled" | "notice.published";

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  dedupeKey: string;
}

const BATCH = 500;
export const MAX_PER_CALL = 20_000;
const LINK = /^\/portal\/[A-Za-z0-9/_-]{1,200}$/;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Inserts the drafts (deduplicated, batched). Invalid links are dropped. Returns how many rows were new. */
export async function deliver(drafts: readonly NotificationDraft[]): Promise<number> {
  const rows = drafts
    .filter((d) => LINK.test(d.link) && d.userId && d.dedupeKey)
    .slice(0, MAX_PER_CALL)
    .map((d) => ({ userId: d.userId, type: d.type, title: cut(d.title, 120), body: cut(d.body, 300), link: d.link, channel: "IN_APP" as const, dedupeKey: cut(d.dedupeKey, 120) }));
  let created = 0;
  for (let i = 0; i < rows.length; i += BATCH) created += (await prisma.notification.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true })).count;
  return created;
}

/**
 * Call AFTER `prisma.$transaction(...)` resolved. Builds and delivers; never throws (the change is already committed —
 * a missed notification must not turn a saved register or receipt into an error page).
 */
export async function afterCommit(label: string, build: () => Promise<readonly NotificationDraft[]>): Promise<void> {
  try {
    await deliver(await build());
  } catch (e) {
    console.error(`notifications (${label}) failed`, e instanceof Error ? e.name : "unknown");
  }
}

/** Removes a family account's notifications about one student (P24 custody block: nothing about the child remains). */
export async function forgetStudentNotifications(userIds: readonly string[], studentId: string): Promise<number> {
  if (userIds.length === 0) return 0;
  const prefixes = ["absence", "result", "receipt", "receipt-cancel"].map((k) => `${k}:${studentId}:`);
  const r = await prisma.notification.deleteMany({ where: { userId: { in: [...userIds] }, OR: prefixes.map((p) => ({ dedupeKey: { startsWith: p } })) } });
  return r.count;
}

/** Review 6C-M2 M3: a withdrawn notice's notifications go too (its title must not linger in up to 20,000 inboxes). */
export async function forgetNoticeNotifications(noticeId: string): Promise<number> {
  return (await prisma.notification.deleteMany({ where: { dedupeKey: `notice:${noticeId}` } })).count;
}

/**
 * What a stored notification is about, from its dedupe key — the portal inbox shows a row only while the account may
 * still see that (notifications.portal; review 6C-M2 M1/M2/L1–L3). Unknown keys → null (never shown in the portal).
 */
export type NotificationTarget = { kind: "student"; studentId: string; capability: "attendance" | "results" | "fees" } | { kind: "notice"; noticeId: string };
const KEY_CAPABILITY = { absence: "attendance", result: "results", receipt: "fees", "receipt-cancel": "fees" } as const;

export function notificationTarget(dedupeKey: string | null): NotificationTarget | null {
  if (!dedupeKey) return null;
  const parts = dedupeKey.split(":");
  if (parts[0] === "notice" && parts.length === 2 && parts[1]) return { kind: "notice", noticeId: parts[1] };
  const cap = Object.hasOwn(KEY_CAPABILITY, parts[0]) ? KEY_CAPABILITY[parts[0] as keyof typeof KEY_CAPABILITY] : null;
  if (cap && parts.length >= 3 && parts[1]) return { kind: "student", studentId: parts[1], capability: cap };
  return null;
}

/** Stored links are portal paths only (checked on write and again before a redirect). */
export const isPortalLink = (link: string | null): link is string => link !== null && LINK.test(link);

// ───────────────────────────── the account's own rows (the portal reads filter them: notifications.portal) ─────────────────────────────

export async function markAllMyNotificationsRead(ctx: AuthContext): Promise<number> {
  return (await prisma.notification.updateMany({ where: { userId: ctx.userId, readAt: null }, data: { readAt: new Date() } })).count;
}

/** Marks the account's notification with this dedupe key read (e.g. opening the notice it announced). */
export async function markMyNotificationReadByKey(ctx: AuthContext, dedupeKey: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId: ctx.userId, dedupeKey, readAt: null }, data: { readAt: new Date() } });
}
