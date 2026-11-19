import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";
import { TIME_RE } from "./timetable.rules";

/** Phase 4A-M3 timetable (PHASE_4_PLAN.md AC5). `.strict()`; the service re-checks everything under the timetable lock. */
const time = z.string().trim().regex(TIME_RE, "Use a time like 08:40.");
const day = z.coerce.number().int().min(0).max(6);

export const periodRowSchema = z
  .object({
    startTime: time,
    endTime: time,
    kind: z.enum(["TEACHING", "BREAK"]),
    label: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().max(40, "Use at most 40 characters."))
      .transform((v) => (v === "" ? null : v)),
  })
  .strict()
  .refine((p) => p.endTime > p.startTime, { message: "A period must end after it starts.", path: ["endTime"] });

/**
 * One weekday's plan, in order (period numbers are the positions, 1…n). `fingerprint` is what the screen showed
 * ("id:version" of each saved period, in order) — a different saved plan means someone else changed it (stale).
 */
export const saveDayPlanSchema = z
  .object({
    academicSessionId: idField,
    dayOfWeek: day,
    periods: z.array(periodRowSchema).max(15, "At most 15 periods a day."),
    fingerprint: z.string().max(2000),
  })
  .strict();

export const copyDayPlanSchema = z
  .object({
    academicSessionId: idField,
    fromDay: day,
    toDays: z.array(day).min(1, "Choose at least one day.").max(6),
    /** Review 4A L4: "day=fingerprint" of every weekday as the screen showed it; a target day that changed since is refused. */
    fingerprints: z.record(z.string().regex(/^[0-6]$/), z.string().max(2000)),
  })
  .strict()
  .refine((v) => !v.toDays.includes(v.fromDay), { message: "Choose days other than the one copied.", path: ["toDays"] })
  .refine((v) => new Set(v.toDays).size === v.toDays.length, { message: "Each day may appear only once.", path: ["toDays"] });

export const setSlotSchema = z
  .object({
    sectionId: idField,
    periodId: idField,
    /** null clears the period for this section. */
    classSubjectId: idField.nullable(),
    /** Version of the current slot, or null when the period is empty for this section. */
    version: versionField.nullable(),
  })
  .strict();

export type PeriodRow = z.infer<typeof periodRowSchema>;
export type SaveDayPlanInput = z.infer<typeof saveDayPlanSchema>;
export type CopyDayPlanInput = z.infer<typeof copyDayPlanSchema>;
export type SetSlotInput = z.infer<typeof setSlotSchema>;
