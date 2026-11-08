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
  loginPerUser: { name: "login:user", limit: 10, windowSeconds: 15 * 60 },
  passwordReset: { name: "reset", limit: 5, windowSeconds: 60 * 60 },
  resetTokenCheck: { name: "reset-check", limit: 30, windowSeconds: 60 * 60 },
  publicForm: { name: "form", limit: 5, windowSeconds: 60 * 60 },
  chatbot: { name: "chat", limit: 20, windowSeconds: 10 * 60 },
} satisfies Record<string, RateLimitRule>;

const memory = new Map<string, { count: number; expiresAt: number }>();

/** Pure: bucket key for a subject in a window. Subjects may be usernames/emails → keyed hash only. */
export function bucketKey(rule: RateLimitRule, subject: string, windowStart: number): string {
  return `${rule.name}:${hashIdentifier(`rl:${subject}`)}:${windowStart}`;
}

export async function hit(rule: RateLimitRule, subject: string): Promise<{ allowed: boolean; remaining: number }> {
  const windowStart = Math.floor(Date.now() / 1000 / rule.windowSeconds) * rule.windowSeconds;
  const key = bucketKey(rule, subject, windowStart);
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

export async function enforce(rule: RateLimitRule, subject: string): Promise<void> {
  const { allowed } = await hit(rule, subject);
  if (!allowed) throw new RateLimitedError();
}

/** Housekeeping (cron): keeps the table small on Neon's free storage. */
export async function purgeExpiredBuckets(): Promise<number> {
  const { count } = await prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return count;
}
