import { z } from "zod";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";

/** Phase 4C-M2 homework (AC17; text only — attachments later, KI-094). `.strict()`. */
const CONTROL_LINE = /[\u0000-\u001F\u007F​﻿]/;
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/; // keeps \t \n \r

const title = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "Give the homework a title.").max(150, "Use at most 150 characters."))
  .refine((v) => !CONTROL_LINE.test(v), "Remove control characters.");

const details = z
  .string()
  .transform((v) => v.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim())
  .pipe(z.string().min(1, "Describe the homework.").max(4000, "Use at most 4000 characters."))
  .refine((v) => !CONTROL_TEXT.test(v), "Remove control characters.");

export const homeworkTargetSchema = z.object({ sectionId: idField, classSubjectId: idField }).strict();
export const createHomeworkSchema = z.object({ sectionId: idField, classSubjectId: idField, title, details, dueOn: isoDateSchema }).strict();
export const updateHomeworkSchema = z.object({ id: idField, version: versionField, title, details, dueOn: isoDateSchema }).strict();
export const homeworkRefSchema = z.object({ id: idField, version: versionField }).strict();
export const sectionHomeworkSchema = z.object({ sectionId: idField }).strict();

export type HomeworkTargetInput = z.infer<typeof homeworkTargetSchema>;
export type CreateHomeworkInput = z.infer<typeof createHomeworkSchema>;
export type UpdateHomeworkInput = z.infer<typeof updateHomeworkSchema>;
export type HomeworkRefInput = z.infer<typeof homeworkRefSchema>;
