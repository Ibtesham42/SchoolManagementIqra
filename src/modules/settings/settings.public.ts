import { prisma } from "@/lib/db";
import { DEFAULT_SCHOOL_TIMEZONE } from "@/lib/format";

/**
 * Public, non-sensitive school identity for page chrome, PDFs and date formatting.
 * Never returns settings secrets. Cached per server instance (5 min) so crawlers hitting public
 * pages don't keep Neon's compute awake; on DB failure the last good value (or neutral defaults)
 * is returned and the failure is cached briefly (30 s). Writers call invalidateSchoolProfileCache().
 */
export interface PublicSchoolProfile {
  name: string;
  shortCode: string | null;
  affiliationNo: string | null;
  board: string | null;
  address: {
    line1?: string;
    line2?: string | null;
    city?: string;
    district?: string | null;
    state?: string;
    pinCode?: string;
    country?: string;
  } | null;
  phones: string[];
  email: string | null;
  website: string | null;
  logoFileId: string | null;
  timezone: string;
}

export const FALLBACK_PROFILE: PublicSchoolProfile = {
  name: "School",
  shortCode: null,
  affiliationNo: null,
  board: null,
  address: null,
  phones: [],
  email: null,
  website: null,
  logoFileId: null,
  timezone: DEFAULT_SCHOOL_TIMEZONE,
};

const TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 30_000;
let cached: { value: PublicSchoolProfile; until: number } | null = null;

export async function getSchoolProfilePublic(now = Date.now()): Promise<PublicSchoolProfile> {
  if (cached && cached.until > now) return cached.value;
  try {
    const s = await prisma.schoolSetting.findUnique({
      where: { id: "default" },
      select: { name: true, shortCode: true, affiliationNo: true, board: true, address: true, phones: true, email: true, website: true, logoFileId: true, timezone: true },
    });
    const value: PublicSchoolProfile = s
      ? { ...s, address: (s.address as PublicSchoolProfile["address"]) ?? null, timezone: s.timezone || DEFAULT_SCHOOL_TIMEZONE }
      : FALLBACK_PROFILE;
    cached = { value, until: now + TTL_MS };
  } catch {
    cached = { value: cached?.value ?? FALLBACK_PROFILE, until: now + FAILURE_TTL_MS };
  }
  return cached.value;
}

export async function getSchoolName(now = Date.now()): Promise<string> {
  return (await getSchoolProfilePublic(now)).name;
}

/** Configured school time zone (KI-032): used for every date shown in the UI and PDFs. */
export async function getSchoolTimezone(): Promise<string> {
  return (await getSchoolProfilePublic()).timezone;
}

/** Call after settings change so pages and PDFs update immediately. */
export function invalidateSchoolProfileCache(): void {
  cached = null;
}

