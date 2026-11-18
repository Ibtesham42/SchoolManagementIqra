import { z } from "zod";
import { CAPACITY_MAX, CAPACITY_MIN, CLASS_CODE_RE, collapseSpaces, LEVEL_MAX, LEVEL_MIN, SECTION_NAME_RE } from "./academic.rules";

/**
 * Classes & sections input (docs/PHASE_2_CLASSES_SECTIONS_DESIGN.md §5). Shared by server actions and,
 * later, the student import. Every object is `.strict()`; the services re-check everything that
 * depends on the database (session status, class active, teacher eligibility, uniqueness).
 *
 * Numbers arrive from forms as strings: `intField` accepts a number or a string of digits only
 * (no "1e1", "12.5", " ", hex), so what the user typed is exactly what is stored.
 */
const toInt = (v: unknown) => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t === "") return undefined;
  return /^-?\d+$/.test(t) ? Number(t) : Number.NaN;
};
const intField = (min: number, max: number, message: string) =>
  z.preprocess(toInt, z.number(message).int(message).min(min, message).max(max, message));
const optionalIntField = (min: number, max: number, message: string) =>
  z.preprocess(toInt, z.number(message).int(message).min(min, message).max(max, message).optional()).transform((v) => v ?? null);

const id = z.string().trim().min(1).max(64);
const version = intField(1, 2_147_483_647, "Reload the page and try again.");
const capacityMessage = `Enter a capacity from ${CAPACITY_MIN} to ${CAPACITY_MAX}.`;
export const capacitySchema = intField(CAPACITY_MIN, CAPACITY_MAX, capacityMessage);
const optionalCapacity = optionalIntField(CAPACITY_MIN, CAPACITY_MAX, capacityMessage);

export const classCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "Enter a class code.")
  .max(10, "Use at most 10 characters.")
  .regex(CLASS_CODE_RE, "Use letters and digits, optionally joined by single hyphens (e.g. C06, C11-SCI).");

export const classNameSchema = z
  .string()
  .transform(collapseSpaces)
  .pipe(
    z
      .string()
      .min(1, "Enter the class name.")
      .max(60, "Use at most 60 characters.")
      .regex(/^[ -~]+$/, "Use English letters, digits and common punctuation."),
  );

export const sectionNameSchema = z
  .string()
  .transform(collapseSpaces)
  .pipe(
    z
      .string()
      .min(1, "Enter the section name.")
      .max(20, "Use at most 20 characters.")
      .regex(SECTION_NAME_RE, "Use letters and digits (spaces allowed between words), e.g. A or Rose."),
  );

const classFields = {
  code: classCodeSchema,
  name: classNameSchema,
  numericLevel: intField(LEVEL_MIN, LEVEL_MAX, `Choose a level from ${LEVEL_MIN} (pre-primary) to ${LEVEL_MAX}.`),
  displayOrder: z.preprocess((v) => (v === "" || v === undefined ? 0 : v), intField(0, 999, "Enter a number from 0 to 999.")),
  defaultSectionCapacity: optionalCapacity,
};

export const createClassSchema = z.object(classFields).strict();
export const updateClassSchema = z.object({ id, version, ...classFields }).strict();
export const setActiveSchema = z.object({ id, version, active: z.boolean() }).strict();
export const recordRefSchema = z.object({ id, version }).strict();

export const createSectionSchema = z
  .object({ academicSessionId: id, classId: id, name: sectionNameSchema, capacity: optionalCapacity })
  .strict();

/** "Add sections A–D": up to 26 distinct names (case-insensitive) in one transaction. */
export const createSectionsBulkSchema = z
  .object({
    academicSessionId: id,
    classId: id,
    names: z.array(sectionNameSchema).min(1, "Enter at least one section name.").max(26, "Up to 26 sections at a time."),
    capacity: optionalCapacity,
  })
  .strict()
  .refine((v) => new Set(v.names.map((n) => n.toLowerCase())).size === v.names.length, { message: "Each section name may appear only once.", path: ["names"] });

export const updateSectionSchema = z.object({ id, version, name: sectionNameSchema, capacity: capacitySchema }).strict();
export const assignClassTeacherSchema = z.object({ id, version, userId: id }).strict();
export const listSectionsSchema = z.object({ academicSessionId: id, classId: id.optional() }).strict();

export const copySectionsSchema = z
  .object({ fromSessionId: id, toSessionId: id })
  .strict()
  .refine((v) => v.fromSessionId !== v.toSessionId, { message: "Choose a different session to copy from.", path: ["fromSessionId"] });

export const defaultSectionCapacitySchema = z.object({ defaultSectionCapacity: capacitySchema }).strict();

export type CreateClassInput = z.infer<typeof createClassSchema>;
export type UpdateClassInput = z.infer<typeof updateClassSchema>;
export type CreateSectionInput = z.infer<typeof createSectionSchema>;
export type CreateSectionsBulkInput = z.infer<typeof createSectionsBulkSchema>;
export type UpdateSectionInput = z.infer<typeof updateSectionSchema>;
export type AssignClassTeacherInput = z.infer<typeof assignClassTeacherSchema>;
export type CopySectionsInput = z.infer<typeof copySectionsSchema>;

/** "A, B, C, D" / "A B C" / one per line → ["A", "B", "C", "D"] (names with spaces need commas or lines). */
export function splitSectionNames(raw: string): string[] {
  const parts = /[,\n]/.test(raw) ? raw.split(/[,\n]/) : raw.split(/\s+/);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}
