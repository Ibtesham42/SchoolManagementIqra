import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Pure Phase 3B leave & attendance rules (no I/O — unit tested). PHASE_3B_PLAN.md, owner decisions L1–L12.
 * Days are decimal.js values (rule 7 spirit: never JS floats for counted quantities stored as Decimal).
 */

// ───────────────────────────── Weekly off (L3) ─────────────────────────────

/** 0 = Sunday … 6 = Saturday. `saturdays` lists which Saturdays of the month (1–5) are off, e.g. [2, 4]. */
export interface WeeklyOff {
  days: number[];
  saturdays: number[];
}

export const weeklyOffSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .max(6, "At least one day of the week must be a working day.")
      .refine(
        (a) => new Set(a).size === a.length,
        "Each day may appear only once.",
      ),
    saturdays: z
      .array(z.number().int().min(1).max(5))
      .max(5)
      .refine(
        (a) => new Set(a).size === a.length,
        "Each Saturday may appear only once.",
      ),
  })
  .strict()
  .refine((w) => !(w.days.includes(6) && w.saturdays.length > 0), {
    message: "Choose either every Saturday or some Saturdays, not both.",
    path: ["saturdays"],
  });

/** No setting yet → no weekly off (never an invented default; the school sets it in Settings). */
export const NO_WEEKLY_OFF: WeeklyOff = { days: [], saturdays: [] };

/** Stored JSON → WeeklyOff (malformed or missing → none; the settings service only ever stores valid values). */
export function readWeeklyOff(stored: unknown): WeeklyOff {
  const parsed = weeklyOffSchema.safeParse(stored);
  return parsed.success
    ? {
        days: [...parsed.data.days].sort(),
        saturdays: [...parsed.data.saturdays].sort(),
      }
    : NO_WEEKLY_OFF;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const parseIso = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Dates are school-local calendar dates represented at UTC midnight (as stored in `date` columns). */
export function isWeeklyOff(iso: string, w: WeeklyOff): boolean {
  const d = parseIso(iso);
  const dow = d.getUTCDay();
  if (w.days.includes(dow)) return true;
  if (dow === 6 && w.saturdays.length) {
    const nth = Math.floor((d.getUTCDate() - 1) / 7) + 1; // 1st … 5th Saturday of the month
    return w.saturdays.includes(nth);
  }
  return false;
}

// ───────────────────────────── Working days (L1, L3, L10) ─────────────────────────────

export interface DayKind {
  date: string;
  kind: "working" | "weekly_off" | "holiday";
}

/** Every date from `from` to `to` inclusive (both ISO), classified. Ranges are bounded by the caller (≤ 366 days). */
export function classifyRange(
  from: string,
  to: string,
  w: WeeklyOff,
  staffHolidays: ReadonlySet<string>,
): DayKind[] {
  const out: DayKind[] = [];
  for (
    let d = parseIso(from);
    isoDate(d) <= to;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const iso = isoDate(d);
    out.push({
      date: iso,
      kind: staffHolidays.has(iso)
        ? "holiday"
        : isWeeklyOff(iso, w)
          ? "weekly_off"
          : "working",
    });
    if (out.length > 366) throw new Error("Range too long");
  }
  return out;
}

/**
 * Leave days for a request: working days in the range; a half-day request (single date) counts 0.5. Returns 0 when
 * the range has no working day (the service refuses such a request).
 */
export function leaveDays(
  input: { from: string; to: string; halfDay: boolean },
  w: WeeklyOff,
  staffHolidays: ReadonlySet<string>,
): Decimal {
  const working = classifyRange(input.from, input.to, w, staffHolidays).filter(
    (d) => d.kind === "working",
  ).length;
  if (input.halfDay)
    return working === 1 && input.from === input.to
      ? new Decimal("0.5")
      : new Decimal(0);
  return new Decimal(working);
}

// ───────────────────────────── Leave types and balances ─────────────────────────────

export const LEAVE_APPLIES_TO = ["ALL", "TEACHING", "NON_TEACHING"] as const;
export type LeaveAppliesTo = (typeof LEAVE_APPLIES_TO)[number];
export const LEAVE_APPLIES_TO_LABEL: Record<LeaveAppliesTo, string> = {
  ALL: "All staff",
  TEACHING: "Teaching staff",
  NON_TEACHING: "Non-teaching staff",
};

/** Days as typed in a form: whole or half days, 0–366 (Decimal(4,1) / (5,1) in the database). */
export const DAYS_RE = /^\d{1,3}(\.[05])?$/;
export function parseDays(raw: string): Decimal | null {
  const t = raw.trim();
  if (!DAYS_RE.test(t)) return null;
  const d = new Decimal(t);
  return d.lte(366) ? d : null;
}

/** Available = allotted + carried forward − used (never negative for paid types — L5, checked by the service). */
export function available(b: {
  allotted: Decimal.Value;
  carriedForward: Decimal.Value;
  used: Decimal.Value;
}): Decimal {
  return new Decimal(b.allotted).plus(b.carriedForward).minus(b.used);
}

export const HOLIDAY_APPLIES_TO = ["ALL", "STAFF", "STUDENTS"] as const;
export type HolidayAppliesTo = (typeof HOLIDAY_APPLIES_TO)[number];
export const HOLIDAY_APPLIES_TO_LABEL: Record<HolidayAppliesTo, string> = {
  ALL: "Everyone",
  STAFF: "Staff only",
  STUDENTS: "Students only",
};
/** Holidays that are days off for STAFF (Phase 3B). */
export const STAFF_HOLIDAY_SCOPES: readonly HolidayAppliesTo[] = [
  "ALL",
  "STAFF",
];
