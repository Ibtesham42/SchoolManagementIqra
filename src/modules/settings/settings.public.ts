import { prisma } from "@/lib/db";

/**
 * Public, non-sensitive school identity for page chrome. Never returns settings secrets.
 * Cached per server instance (5 min) so crawlers hitting public pages don't keep Neon's
 * compute awake (free-tier CU-hours). On DB failure a neutral label is returned and the
 * failure is cached briefly (30 s) to avoid hammering an unavailable database.
 */
const TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
let cached: { value: string; until: number } | null = null;

export async function getSchoolName(now = Date.now()): Promise<string> {
  if (cached && cached.until > now) return cached.value;
  try {
    const setting = await prisma.schoolSetting.findUnique({ where: { id: "default" }, select: { name: true } });
    cached = { value: setting?.name ?? "School", until: now + TTL_MS };
  } catch {
    cached = { value: cached?.value ?? "School", until: now + FAILURE_TTL_MS };
  }
  return cached.value;
}

/** Call after the school name changes in Settings (Phase 14) so pages update immediately. */
export function invalidateSchoolNameCache(): void {
  cached = null;
}
