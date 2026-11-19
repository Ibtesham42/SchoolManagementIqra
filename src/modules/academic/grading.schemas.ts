import { z } from "zod";
import { masterNameSchema } from "@/modules/hr/hr.schemas";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 4B-M2 grading scales (AC8). Bands are validated again with grade-calc.validateScale in the service. */
const PERCENT_RE = /^\d{1,3}(\.\d{1,2})?$/;
const CONTROL = /[\u0000-\u001F\u007F​﻿]/;
export const bandSchema = z
  .object({
    minPercent: z.string().trim().regex(PERCENT_RE, "Use a percentage like 33 or 32.5."),
    grade: z.string().trim().min(1, "Enter a grade.").max(5, "Use at most 5 characters.").refine((v) => !CONTROL.test(v), "Remove control characters."),
    gradePoint: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .pipe(z.string().regex(/^\d{1,2}(\.\d)?$/, "Use a grade point like 9 or 8.5.").nullable()),
    remark: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().max(60, "Use at most 60 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters.")
      .transform((v) => (v === "" ? null : v)),
  })
  .strict();

export const createScaleSchema = z.object({ name: masterNameSchema, bands: z.array(bandSchema).min(2, "Add at least two bands.").max(20, "Use at most 20 bands.") }).strict();
export const updateScaleSchema = z.object({ id: idField, version: versionField, name: masterNameSchema, bands: z.array(bandSchema).min(2).max(20) }).strict();
export const setScaleActiveSchema = z.object({ id: idField, version: versionField, active: z.boolean() }).strict();

export type CreateScaleInput = z.infer<typeof createScaleSchema>;
export type UpdateScaleInput = z.infer<typeof updateScaleSchema>;
export type SetScaleActiveInput = z.infer<typeof setScaleActiveSchema>;
