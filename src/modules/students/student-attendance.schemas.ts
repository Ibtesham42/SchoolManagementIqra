import { z } from "zod";
import { STUDENT_STATUSES } from "@/modules/academic/student-attendance.rules";
import { idField, isoDateSchema, versionField } from "./person.schemas";

/** Phase 4A-M4 daily student attendance (PHASE_4_PLAN.md AC6, AC7). `.strict()`. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;

export const studentDaySchema = z.object({ sectionId: idField, date: isoDateSchema }).strict();

export const markStudentDaySchema = z
  .object({
    sectionId: idField,
    date: isoDateSchema,
    entries: z
      .array(
        z
          .object({
            enrollmentId: idField,
            status: z.enum(STUDENT_STATUSES, "Choose present, absent, late, half day or excused."),
            version: versionField.nullable(),
          })
          .strict(),
      )
      .min(1, "Nobody to mark.")
      .max(200, "A section has at most 200 students."),
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/[ \t]+/g, " "))
      .pipe(z.string().max(500, "Use at most 500 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters.")
      .refine((v) => v === "" || v.length >= 3, "Say briefly why saved marks are changed."),
  })
  .strict()
  .refine((v) => new Set(v.entries.map((e) => e.enrollmentId)).size === v.entries.length, { message: "Each student may appear only once.", path: ["entries"] });

export const studentMonthSchema = z
  .object({ sectionId: idField, month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use a month like 2026-11.") })
  .strict();

export type StudentDayInput = z.infer<typeof studentDaySchema>;
export type MarkStudentDayInput = z.infer<typeof markStudentDaySchema>;
export type StudentMonthInput = z.infer<typeof studentMonthSchema>;
