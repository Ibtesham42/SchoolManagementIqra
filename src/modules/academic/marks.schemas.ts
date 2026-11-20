import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 4B-M4/M5 marks entry, sheet workflow, results and report-card remarks (PHASE_4_PLAN.md AC10, AC13–AC15). */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;

const freeText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().max(max, `Use at most ${max} characters.`))
    .refine((v) => !CONTROL.test(v), "Remove control characters.");

/** Blank → null; otherwise a whole or half mark (the service checks it against the part's maximum). */
const mark = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().regex(/^\d{1,4}(\.5|\.0)?$/, "Use whole or half marks (e.g. 42 or 42.5).").nullable());

export const sheetRefSchema = z.object({ examSubjectId: idField, sectionId: idField }).strict();

export const saveMarksSchema = z
  .object({
    examSubjectId: idField,
    sectionId: idField,
    /** The sheet's version as loaded (null when no sheet exists yet). */
    sheetVersion: versionField.nullable(),
    entries: z
      .array(
        z
          .object({
            enrollmentId: idField,
            status: z.enum(["PRESENT", "ABSENT", "EXEMPT"], "Choose present, AB or EX."),
            theory: mark,
            practical: mark,
            internal: mark,
            version: versionField.nullable(),
          })
          .strict(),
      )
      .min(1, "Nobody to save.")
      .max(200, "A section has at most 200 students."),
    reason: freeText(500).refine((v) => v === "" || v.length >= 3, "Say briefly why approved marks are changed."),
    /** 4C-M4: recorded in the audit row only — the rules are the same for the grid and an import. */
    source: z.enum(["grid", "import"]).optional(),
  })
  .strict()
  .refine((v) => new Set(v.entries.map((e) => e.enrollmentId)).size === v.entries.length, { message: "Each student may appear only once.", path: ["entries"] });

export const sheetActionSchema = z
  .object({ examSubjectId: idField, sectionId: idField, sheetVersion: versionField, action: z.enum(["submit", "return", "approve"]) })
  .strict();

export const examRefSchema = z.object({ id: idField, version: versionField }).strict();

export const sectionResultsSchema = z.object({ examinationId: idField, sectionId: idField }).strict();

export const reportCardRemarkSchema = z
  .object({ id: idField, version: versionField, remark: freeText(300).transform((v) => (v === "" ? null : v)) })
  .strict();

export type SheetRefInput = z.infer<typeof sheetRefSchema>;
export type SaveMarksInput = z.infer<typeof saveMarksSchema>;
export type SheetActionInput = z.infer<typeof sheetActionSchema>;
export type ExamRefInput = z.infer<typeof examRefSchema>;
export type SectionResultsInput = z.infer<typeof sectionResultsSchema>;
export type ReportCardRemarkInput = z.infer<typeof reportCardRemarkSchema>;
