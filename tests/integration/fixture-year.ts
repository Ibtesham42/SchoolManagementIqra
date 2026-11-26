import type { prisma as Prisma } from "@/lib/db";

/**
 * A synthetic academic-session year that is free on the Test branch.
 *
 * Constraints the fixtures must meet against a real database:
 * - the year is in the PAST — services refuse future attendance, receipts, back-dated corrections and so on;
 * - a fixture child born on FIXTURE_DOB (the DB CHECK allows 1990 onwards) is born before the session starts;
 * - the `span` consecutive sessions [Y-04-01 … (Y+span)-03-31] overlap no existing session (sessions never overlap,
 *   and earlier failed runs may have left theirs behind).
 * Integration files run one at a time (vitest.config.ts), so a year picked here is still free when the suite creates it.
 */
// A random day in 1990 for each run, so a fixture child never matches one left behind by an earlier run in the
// admission duplicate check (same name + date of birth).
export const FIXTURE_DOB = new Date(Date.UTC(1990, 0, 1) + Math.floor(Math.random() * 364) * 86_400_000).toISOString().slice(0, 10);

const FIRST_YEAR = 1991;

export async function freeFixtureYear(prisma: typeof Prisma, span = 1): Promise<number> {
  const lastYear = new Date().getUTCFullYear() - span - 1;
  const sessions = await prisma.academicSession.findMany({ select: { startDate: true, endDate: true } });
  const free: number[] = [];
  for (let y = FIRST_YEAR; y <= lastYear; y++) {
    const from = Date.UTC(y, 3, 1);
    const to = Date.UTC(y + span, 2, 31);
    if (!sessions.some((s) => s.startDate.getTime() <= to && s.endDate.getTime() >= from)) free.push(y);
  }
  if (free.length === 0) throw new Error(`No free past session year for a ${span}-session fixture on the Test branch (${FIRST_YEAR}–${lastYear}).`);
  return free[Math.floor(Math.random() * free.length)];
}
