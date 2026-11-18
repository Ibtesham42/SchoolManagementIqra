import { z } from "zod";
import { addressSchema } from "@/modules/settings/settings.schemas";
import { cleanText } from "./admissions.rules";

import {
  dobField,
  GENDERS,
  GUARDIAN_RELATIONS,
  idField as id,
  isoDateSchema,
  nameField as name,
  optionalEmailField as optionalEmail,
  optionalNameField as optionalName,
  optionalPhoneField as optionalPhone,
  optionalTextField as optionalText,
  phoneField as phone,
  versionField as version,
} from "@/modules/students/person.schemas";

export { GENDERS, GUARDIAN_RELATIONS, isoDateSchema };

/**
 * Admission input (design §5.1). One `.strict()` schema per form step; the service re-checks everything
 * that depends on the database (session/class state, status, version). Values arrive from forms as strings.
 */

// ── Step 1: student & class applied for (creates the draft) ──
export const studentStepFields = {
  academicSessionId: id,
  classId: id,
  firstName: name("first name"),
  middleName: optionalName("middle name"),
  lastName: optionalName("last name"),
  dob: dobField,
  gender: z.enum(GENDERS, "Choose the gender."),
};
export const createDraftSchema = z.object(studentStepFields).strict();
export const updateStudentStepSchema = z.object({ id, version, ...studentStepFields }).strict();

// ── Step 2: parents / guardians ──
export const guardianSchema = z
  .object({
    relation: z.enum(GUARDIAN_RELATIONS, "Choose the relation."),
    name: name("name", 120),
    phone,
    altPhone: optionalPhone,
    email: optionalEmail,
    occupation: optionalText(80),
    isPrimary: z.boolean(),
    isEmergencyContact: z.boolean(),
  })
  .strict();
export const guardiansStepSchema = z
  .object({ id, version, guardians: z.array(guardianSchema).min(1, "Add at least one parent or guardian.").max(4, "Up to 4 guardians.") })
  .strict()
  .refine((v) => v.guardians.filter((g) => g.isPrimary).length === 1, { message: "Choose exactly one primary contact.", path: ["primary"] })
  .refine((v) => v.guardians.filter((g) => g.relation === "FATHER").length <= 1 && v.guardians.filter((g) => g.relation === "MOTHER").length <= 1, {
    message: "Enter at most one father and one mother.",
    path: ["guardians"],
  });

// ── Step 3: contact & address ──
export const contactStepSchema = z.object({ id, version, phone: optionalPhone, email: optionalEmail, address: addressSchema }).strict();

// ── Step 4: previous school ──
export const previousSchoolSchema = z
  .object({
    name: optionalText(150),
    board: optionalText(60),
    lastClass: optionalText(40),
    yearLeft: z
      .string()
      .trim()
      .transform((v) => (v === "" ? null : v))
      .pipe(z.string().regex(/^(19|20)\d{2}$/, "Use a 4-digit year.").nullable()),
    tcNumber: optionalText(40),
  })
  .strict();
export const previousSchoolStepSchema = z.object({ id, version, previousSchool: previousSchoolSchema }).strict();

// ── Workflow ──
export const recordRefSchema = z.object({ id, version }).strict();
const reason = (label: string) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.string().min(3, `Enter the ${label} (at least 3 characters).`).max(500, "Use at most 500 characters."));
export const reasonSchema = z.object({ id, version, reason: reason("reason") }).strict();
export const setSectionSchema = z.object({ id, version, sectionId: id }).strict();

export const ADMISSION_STATUSES = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "REJECTED"] as const;
export const listApplicationsSchema = z
  .object({
    academicSessionId: id.optional(),
    classId: id.optional(),
    status: z.enum(ADMISSION_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateStudentStepInput = z.infer<typeof updateStudentStepSchema>;
export type GuardianInput = z.infer<typeof guardianSchema>;
export type GuardiansStepInput = z.infer<typeof guardiansStepSchema>;
export type ContactStepInput = z.infer<typeof contactStepSchema>;
export type PreviousSchoolStepInput = z.infer<typeof previousSchoolStepSchema>;
export type ListApplicationsInput = z.infer<typeof listApplicationsSchema>;

// ── Approval = registration (S5, D1) ──
const optionalReason = z
  .string()
  .transform(cleanText)
  .pipe(z.union([z.literal(""), z.string().min(3, "Give a reason of at least 3 characters.").max(500, "Use at most 500 characters.")]))
  .transform((v) => (v === "" ? null : v));

export const approveSchema = z
  .object({
    id,
    version,
    admissionDate: isoDateSchema,
    /** Required (by the service) only when duplicates were found. */
    duplicateOverride: optionalReason,
    /** Applicant-guardian id → existing Guardian id, or null = create a new guardian (D9). */
    guardianLinks: z.record(z.string().min(1).max(64), z.string().min(1).max(64).nullable()),
  })
  .strict();
export type ApproveInput = z.infer<typeof approveSchema>;
