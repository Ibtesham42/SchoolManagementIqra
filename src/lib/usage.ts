import { prisma } from "@/lib/db";
import { QuotaExceededError } from "@/lib/errors";
import { levelFor, type UsageLevel } from "@/lib/usage-policy";

export { levelFor, WARN_RATIO } from "@/lib/usage-policy";

/**
 * Free-tier cost protection (docs/FREE_TIER.md). Every metered external call
 * (email, AI, public media upload) goes through `consume()`, which:
 *   - hard-stops at the configured cap (the app degrades to its fallback instead of
 *     incurring charges or hitting the provider's limit),
 *   - reports "warning" once usage crosses WARN_RATIO of the cap.
 * Caps are deliberately set BELOW the providers' published free limits.
 */
export type Metric = "email.sent" | "ai.requests" | "media.uploads";

/** Daily caps. Defaults are conservative; override via env (USAGE_CAP_<METRIC>). */
const DEFAULT_DAILY_CAPS: Record<Metric, number> = {
  "email.sent": 90, // Resend Free: 100/day, 3,000/month
  "ai.requests": 0, // AI disabled unless explicitly configured
  "media.uploads": 200,
};

export function dailyCap(metric: Metric): number {
  const envName = `USAGE_CAP_${metric.replace(".", "_").toUpperCase()}`;
  const fromEnv = process.env[envName];
  if (metric === "ai.requests" && process.env.AI_DAILY_REQUEST_LIMIT) return Number(process.env.AI_DAILY_REQUEST_LIMIT);
  return fromEnv !== undefined ? Number(fromEnv) : DEFAULT_DAILY_CAPS[metric];
}

function today(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface UsageStatus {
  metric: Metric;
  used: number;
  cap: number;
  level: UsageLevel;
}

/**
 * Atomically reserves `amount` units. Throws QuotaExceededError (without consuming)
 * if the reservation would exceed today's cap.
 */
export async function consume(metric: Metric, amount = 1): Promise<UsageStatus> {
  const cap = dailyCap(metric);
  if (amount > cap) {
    throw new QuotaExceededError(`Daily limit for ${metric} reached (${cap}). Service paused until tomorrow.`);
  }
  const day = today();
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO usage_counter (metric, day, count) VALUES (${metric}, ${day}, ${amount})
    ON CONFLICT (metric, day) DO UPDATE SET count = usage_counter.count + ${amount}
    WHERE usage_counter.count + ${amount} <= ${cap}
    RETURNING count`;
  // No row returned → the WHERE guard blocked the update (cap reached).
  if (rows.length === 0 || rows[0].count > cap) {
    throw new QuotaExceededError(`Daily limit for ${metric} reached (${cap}). Service paused until tomorrow.`);
  }
  return { metric, used: rows[0].count, cap, level: levelFor(rows[0].count, cap) };
}

export async function usageToday(): Promise<UsageStatus[]> {
  const rows = await prisma.usageCounter.findMany({ where: { day: today() } });
  const metrics = Object.keys(DEFAULT_DAILY_CAPS) as Metric[];
  return metrics.map((metric) => {
    const used = rows.find((r) => r.metric === metric)?.count ?? 0;
    const cap = dailyCap(metric);
    return { metric, used, cap, level: levelFor(used, cap) };
  });
}
