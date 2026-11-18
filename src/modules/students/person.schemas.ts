import { z } from "zod";
import { cleanText, normalizePhone } from "./person-fields";

/**
 * Zod field schemas for people (students, applicants, guardians), shared by admissions and student
 * records so both validate a name, phone or date exactly the same way. Values arrive from forms as strings.
 */
export const idField = z.string().trim().min(1).max(64);
export const versionField = z.preprocess(
  (v) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v),
  z.number("Reload the page and try again.").int().min(1, "Reload the page and try again."),
);

/** Letters (any script), marks, spaces, apostrophes, dots and hyphens; starts with a letter. */
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u;
export const nameField = (label: string, max = 60) =>
  z
    .string()
    .transform(cleanText)
    .pipe(
      z
        .string()
        .min(1, `Enter the ${label}.`)
        .max(max, `Use at most ${max} characters.`)
        .regex(NAME_RE, "Use letters, spaces, apostrophes, dots or hyphens."),
    );
export const optionalNameField = (label: string, max = 60) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.union([z.literal(""), z.string().max(max, `Use at most ${max} characters.`).regex(NAME_RE, `Check the ${label}.`)]))
    .transform((v) => (v === "" ? null : v));
export const optionalTextField = (max: number) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.string().max(max, `Use at most ${max} characters.`))
    .transform((v) => (v === "" ? null : v));

export const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Use a valid date.");
/** Same lower bound as the database CHECK on date of birth. */
export const dobField = isoDateSchema.refine((v) => v >= "1990-01-01", "Check the date of birth.");

export const phoneField = z
  .string()
  .transform((v) => normalizePhone(v) ?? `invalid:${v}`)
  .pipe(z.string().regex(/^\d{10}$/, "Enter a 10-digit mobile or landline number (optional +91)."));
export const optionalPhoneField = z
  .string()
  .transform((v) => (v.trim() === "" ? null : (normalizePhone(v) ?? `invalid:${v}`)))
  .pipe(z.string().regex(/^\d{10}$/, "Enter a 10-digit number (optional +91).").nullable());
export const optionalEmailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === "" ? null : v))
  .pipe(z.email("Enter a valid email address.").nullable());

export const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;
export const GUARDIAN_RELATIONS = ["FATHER", "MOTHER", "GUARDIAN", "OTHER"] as const;
