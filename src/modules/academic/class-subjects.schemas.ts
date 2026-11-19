import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 4A-M2 class subjects (PHASE_4_PLAN.md AC3): what a class studies in one academic session. `.strict()`. */
const bool = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());

export const listClassSubjectsSchema = z.object({ academicSessionId: idField, classId: idField }).strict();

export const addClassSubjectsSchema = z
  .object({
    academicSessionId: idField,
    classId: idField,
    subjectIds: z.array(idField).min(1, "Choose at least one subject.").max(30, "Add at most 30 subjects at a time."),
    isOptional: bool,
  })
  .strict()
  .refine((v) => new Set(v.subjectIds).size === v.subjectIds.length, { message: "Each subject may appear only once.", path: ["subjectIds"] });

export const updateClassSubjectSchema = z
  .object({
    id: idField,
    version: versionField,
    isOptional: bool,
    sortOrder: z.coerce.number("Enter a number.").int("Use a whole number.").min(0, "Use 0–999.").max(999, "Use 0–999."),
  })
  .strict();

export const classSubjectRefSchema = z.object({ id: idField, version: versionField }).strict();

export const copyClassSubjectsSchema = z
  .object({ fromSessionId: idField, toSessionId: idField })
  .strict()
  .refine((v) => v.fromSessionId !== v.toSessionId, { message: "Choose a different session to copy from.", path: ["fromSessionId"] });

export type ListClassSubjectsInput = z.infer<typeof listClassSubjectsSchema>;
export type AddClassSubjectsInput = z.infer<typeof addClassSubjectsSchema>;
export type UpdateClassSubjectInput = z.infer<typeof updateClassSubjectSchema>;
export type ClassSubjectRefInput = z.infer<typeof classSubjectRefSchema>;
export type CopyClassSubjectsInput = z.infer<typeof copyClassSubjectsSchema>;
