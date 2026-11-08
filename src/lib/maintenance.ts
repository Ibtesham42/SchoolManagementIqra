import { prisma } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";

/**
 * Housekeeping (KI-013): keeps Neon Free storage small. Safe to run any time, idempotent.
 * Triggered by POST /api/cron/cleanup (host cron / GitHub Actions schedule) or `npm run cleanup`.
 */
export const RETENTION = {
  usedResetTokensDays: 7,
  usageCounterDays: 400, // > 1 year, for month-over-month usage review
} as const;

export interface CleanupResult {
  sessions: number;
  rateLimitBuckets: number;
  resetTokens: number;
  usageCounters: number;
}

export async function runCleanup(now = new Date()): Promise<CleanupResult> {
  const day = 24 * 60 * 60 * 1000;
  const [sessions, rateLimitBuckets, resetTokens, usageCounters] = await prisma.$transaction([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.rateLimitBucket.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.passwordResetToken.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date(now.getTime() - RETENTION.usedResetTokensDays * day) } },
          { usedAt: { lt: new Date(now.getTime() - RETENTION.usedResetTokensDays * day) } },
        ],
      },
    }),
    prisma.usageCounter.deleteMany({ where: { day: { lt: new Date(now.getTime() - RETENTION.usageCounterDays * day) } } }),
  ]);
  return {
    sessions: sessions.count,
    rateLimitBuckets: rateLimitBuckets.count,
    resetTokens: resetTokens.count,
    usageCounters: usageCounters.count,
  };
}

/** Bearer-token check for cron endpoints. Disabled (false) when CRON_SECRET is unset or too short. */
export function isAuthorizedCron(authorization: string | null, secret = process.env.CRON_SECRET): boolean {
  if (!secret || secret.length < 32 || !authorization) return false;
  const match = /^Bearer (.+)$/.exec(authorization);
  return !!match && safeEqual(match[1], secret);
}
