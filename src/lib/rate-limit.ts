import { prisma } from "@/lib/db";
import { RateLimitedError } from "@/lib/errors";
import { hashIdentifier } from "@/lib/crypto";

/**
 * Fixed-window rate limiter. "postgres" works across serverless instances (default);
 * "memory" is for single-process dev only. No paid Redis required.
 */
export interface RateLimitRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const RULES = {
  loginPerIp: { name: "login:ip", limit: 20, windowSeconds: 15 * 60 },
  // S-03 (2026-11-10): the old single per-username bucket counted EVERY attempt, so anyone could keep a
  // user out by spending it. Now: every attempt counts per (username, IP) — an attacker elsewhere can't block
  // the user's own address — and only FAILURES count towards a per-username ceiling that bounds distributed
  // guessing. The account lock after 5 failures (auth.service) stays the primary brute-force control.
  loginPerUserIp: { name: "login:user-ip", limit: 10, windowSeconds: 15 * 60 },
  loginFailuresPerUser: { name: "login:user-fail", limit: 30, windowSeconds: 15 * 60 },
  // Current-password checks on the signed-in "change password" form, per user id (S-03: separate from login).
  passwordChange: { name: "password-change", limit: 10, windowSeconds: 15 * 60 },
  passwordReset: { name: "reset", limit: 5, windowSeconds: 60 * 60 },
  resetTokenCheck: { name: "reset-check", limit: 30, windowSeconds: 60 * 60 },
  publicForm: { name: "form", limit: 5, windowSeconds: 60 * 60 },
  chatbot: { name: "chat", limit: 20, windowSeconds: 10 * 60 },
  // Student/admission document uploads (KI-048 route), per signed-in user.
  upload: { name: "upload", limit: 30, windowSeconds: 10 * 60 },
  // Personal-data exports (student CSV), per signed-in user.
  export: { name: "export", limit: 10, windowSeconds: 10 * 60 },
  // Phase 4C-M4: marks import templates, per signed-in user — own bucket so templates don't use up personal-data exports.
  marksTemplate: { name: "marks-template", limit: 30, windowSeconds: 10 * 60 },
  // Public file route (S-04), per client IP — IN-PROCESS only (hitLocal): it must not touch the database.
  filesPerIp: { name: "files:ip", limit: 120, windowSeconds: 60 },
} satisfies Record<string, RateLimitRule>;

const memory = new Map<string, { count: number; expiresAt: number }>();

/**
 * Pure: bucket key for a subject in a window. Subjects may be usernames/emails → keyed hash only. An optional
 * qualifier (e.g. the client IP hash) gives one bucket per (subject, qualifier) while keeping the subject's
 * prefix, so every bucket of a subject can be cleared at once (resetSubject).
 */
export function bucketKey(rule: RateLimitRule, subject: string, windowStart: number, qualifier?: string): string {
  return `${subjectPrefix(rule, subject)}${qualifier === undefined ? "" : `${hashIdentifier(`rlq:${qualifier}`)}:`}${windowStart}`;
}

/** Pure: the key prefix shared by every bucket (any qualifier, any window) of a subject. */
export function subjectPrefix(rule: RateLimitRule, subject: string): string {
  return `${rule.name}:${hashIdentifier(`rl:${subject}`)}:`;
}

const windowOf = (rule: RateLimitRule, now = Date.now()) => Math.floor(now / 1000 / rule.windowSeconds) * rule.windowSeconds;

export async function hit(rule: RateLimitRule, subject: string, qualifier?: string): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = windowOf(rule);
  const key = bucketKey(rule, subject, windowStart, qualifier);
  const expiresAt = new Date((windowStart + rule.windowSeconds) * 1000);

  let count: number;
  if (process.env.RATE_LIMIT_DRIVER === "memory") {
    const entry = memory.get(key);
    count = entry && entry.expiresAt > Date.now() ? entry.count + 1 : 1;
    memory.set(key, { count, expiresAt: expiresAt.getTime() });
  } else {
    const rows = await prisma.$queryRaw<{ count: number }[]>`
      INSERT INTO rate_limit_bucket (key, count, expires_at) VALUES (${key}, 1, ${expiresAt})
      ON CONFLICT (key) DO UPDATE SET count = rate_limit_bucket.count + 1
      RETURNING count`;
    count = rows[0]?.count ?? 1;
  }
  return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count) };
}

export async function enforce(rule: RateLimitRule, subject: string, qualifier?: string): Promise<void> {
  const { allowed } = await hit(rule, subject, qualifier);
  if (!allowed) throw new RateLimitedError();
}

/** Current count of a subject's bucket in this window, WITHOUT counting this call (e.g. failures-only limits). */
export async function peek(rule: RateLimitRule, subject: string, qualifier?: string): Promise<number> {
  const key = bucketKey(rule, subject, windowOf(rule), qualifier);
  if (process.env.RATE_LIMIT_DRIVER === "memory") {
    const entry = memory.get(key);
    return entry && entry.expiresAt > Date.now() ? entry.count : 0;
  }
  const rows = await prisma.$queryRaw<{ count: number }[]>`SELECT count FROM rate_limit_bucket WHERE key = ${key} AND expires_at > now()`;
  return rows[0]?.count ?? 0;
}

/** Refuses when a subject has already reached the limit in this window (the call itself is not counted). */
export async function assertBelowLimit(rule: RateLimitRule, subject: string, qualifier?: string): Promise<void> {
  if ((await peek(rule, subject, qualifier)) >= rule.limit) throw new RateLimitedError();
}

/** Deletes every bucket of a subject for a rule (all qualifiers and windows) — used by admin unlock / resets. */
export async function resetSubject(rule: RateLimitRule, subject: string): Promise<void> {
  const prefix = subjectPrefix(rule, subject);
  if (process.env.RATE_LIMIT_DRIVER === "memory") {
    for (const k of memory.keys()) if (k.startsWith(prefix)) memory.delete(k);
    return;
  }
  await prisma.$executeRaw`DELETE FROM rate_limit_bucket WHERE starts_with(key, ${prefix})`;
}

// ───────────────────────────── In-process limiter (never touches the database) ─────────────────────────────

const local = new Map<string, { count: number; expiresAt: number }>();
export const LOCAL_LIMITER_MAX_KEYS = 10_000;

/**
 * Per-instance fixed-window limiter for public, unauthenticated endpoints that must not reach the database on
 * every request (project security rule; S-04). Bounded memory: expired entries are purged when the map is
 * full, and if it is still full the oldest key is dropped. Limits are per server instance by design.
 */
export function hitLocal(rule: RateLimitRule, subject: string, now = Date.now()): { allowed: boolean; remaining: number } {
  const windowStart = windowOf(rule, now);
  const key = `${rule.name}:${subject}:${windowStart}`;
  const entry = local.get(key);
  const count = entry && entry.expiresAt > now ? entry.count + 1 : 1;
  if (!entry && local.size >= LOCAL_LIMITER_MAX_KEYS) {
    for (const [k, v] of local) if (v.expiresAt <= now) local.delete(k);
    if (local.size >= LOCAL_LIMITER_MAX_KEYS) local.delete(local.keys().next().value!);
  }
  local.set(key, { count, expiresAt: (windowStart + rule.windowSeconds) * 1000 });
  return { allowed: count <= rule.limit, remaining: Math.max(0, rule.limit - count) };
}

/** Test helper: empties the in-process limiter. */
export function resetLocalLimiterForTests(): void {
  local.clear();
}

/** Housekeeping (cron): keeps the table small on Neon's free storage. */
export async function purgeExpiredBuckets(): Promise<number> {
  const { count } = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
