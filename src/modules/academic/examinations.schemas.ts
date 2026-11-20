import { z } from "zod";
import { masterNameSchema } from "@/modules/hr/hr.schemas";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";

/** Phase 4B-M3 examinations (AC9). Dates are school-local ISO dates; blank means "not set". */
const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(isoDateSchema.nullable());

const maxMark = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? 0 : Number(v.trim())) : v),
  z.number({ error: "Enter a whole number." }).int("Enter a whole number.").min(0, "Can't be negative.").max(1000, "Use at most 1000."),
);

const passPercent = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, "Use a percentage like 33.").refine((v) => Number(v) <= 100, "Use at most 100.").nullable());

const examFields = { name: masterNameSchema, gradeScaleId: idField, startDate: optionalDate, endDate: optionalDate };
const datesInOrder = (v: { startDate: string | null; endDate: string | null }) => !v.startDate || !v.endDate || v.endDate >= v.startDate;
const ORDER = { message: "The end date is before the start date.", path: ["endDate"] };

export const createExamSchema = z.object({ academicSessionId: idField, ...examFields }).strict().refine(datesInOrder, ORDER);
export const updateExamSchema = z.object({ id: idField, version: versionField, ...examFields }).strict().refine(datesInOrder, ORDER);
export const examStatusSchema = z.object({ id: idField, version: versionField, to: z.enum(["DRAFT", "SCHEDULED", "MARKS_ENTRY"]) }).strict();

const subjectFields = { examDate: optionalDate, maxTheory: maxMark, maxPractical: maxMark, maxInternal: maxMark, passPercent };
const someMarks = (v: { maxTheory: number; maxPractical: number; maxInternal: number }) => v.maxTheory + v.maxPractical + v.maxInternal > 0;
const SOME = { message: "Give at least one part some maximum marks.", path: ["maxTheory"] };

export const addExamSubjectsSchema = z
  .object({ examinationId: idField, version: versionField, classSubjectIds: z.array(idField).min(1, "Choose at least one subject.").max(100), ...subjectFields })
  .strict()
  .refine(someMarks, SOME);
export const updateExamSubjectSchema = z.object({ id: idField, version: versionField, ...subjectFields }).strict().refine(someMarks, SOME);
export const examSubjectRefSchema = z.object({ id: idField, version: versionField }).strict();
export const listExamsSchema = z.object({ academicSessionId: idField }).strict();

export type CreateExamInput = z.infer<typeof createExamSchema>;
export type UpdateExamInput = z.infer<typeof updateExamSchema>;
export type ExamStatusInput = z.infer<typeof examStatusSchema>;
export type AddExamSubjectsInput = z.infer<typeof addExamSubjectsSchema>;
export type UpdateExamSubjectInput = z.infer<typeof updateExamSubjectSchema>;
export type ExamSubjectRefInput = z.infer<typeof examSubjectRefSchema>;
