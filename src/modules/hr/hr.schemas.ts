import { z } from "zod";
import { addressSchema } from "@/modules/settings/settings.schemas";
import {
  idField,
  isoDateSchema,
  nameField,
  optionalEmailField,
  optionalNameField,
  optionalPhoneField,
  phoneField,
  versionField,
  GENDERS,
} from "@/modules/students/person.schemas";
import { APPOINTMENT_TYPES, cleanMasterName, EARLIEST_DOB, EMPLOYMENT_STATUSES, STATUS_ACTIONS, MASTER_CODE_MAX, MASTER_CODE_RE, masterNameProblem, STAFF_TYPES } from "./hr.rules";

/**
 * Phase 3A HR input (PHASE_3_PLAN.md §9). Every object is `.strict()`: the permanent employee code, the
 * employment status, the staff type (derived from the designation, H9) and audit fields are not fields of any
 * schema, so a crafted request that sends them is refused. The services re-check everything that depends on
 * the database (active master data, reporting target, uniqueness, versions, dates against the school's today).
 */

// ───────────────────────────── Master data ─────────────────────────────

export const masterCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, "Enter a code.")
  .max(MASTER_CODE_MAX, `Use at most ${MASTER_CODE_MAX} characters.`)
  .regex(MASTER_CODE_RE, "Use English letters and digits, optionally joined by single hyphens (e.g. SCI, ADMIN-OFFICE).");

export const masterNameSchema = z
  .string()
  .transform(cleanMasterName)
  .superRefine((v, c) => {
    const problem = masterNameProblem(v);
    if (problem) c.addIssue({ code: "custom", message: problem });
  });

const staffType = z.enum(STAFF_TYPES, "Choose teaching or non-teaching.");

export const createDepartmentSchema = z.object({ code: masterCodeSchema, name: masterNameSchema }).strict();
export const updateDepartmentSchema = z.object({ id: idField, version: versionField, code: masterCodeSchema, name: masterNameSchema }).strict();
export const createDesignationSchema = z.object({ code: masterCodeSchema, name: masterNameSchema, staffType }).strict();
export const updateDesignationSchema = z.object({ id: idField, version: versionField, code: masterCodeSchema, name: masterNameSchema, staffType }).strict();
export const setMasterActiveSchema = z.object({ id: idField, version: versionField, active: z.boolean() }).strict();

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type CreateDesignationInput = z.infer<typeof createDesignationSchema>;
export type UpdateDesignationInput = z.infer<typeof updateDesignationSchema>;
export type SetMasterActiveInput = z.infer<typeof setMasterActiveSchema>;

// ───────────────────────────── Employees ─────────────────────────────

const ADDRESS_KEYS = ["line1", "line2", "city", "district", "state", "pinCode"] as const;
/** Optional home address: all blank (or absent) → null; anything entered → the full address rules. */
const optionalAddress = z.preprocess(
  (v) => (v && typeof v === "object" && ADDRESS_KEYS.every((k) => String((v as Record<string, unknown>)[k] ?? "").trim() === "") ? null : v),
  addressSchema.nullable(),
);

const relationField = z
  .string()
  .trim()
  .min(2, "Enter the relationship, e.g. Spouse.")
  .max(40, "Use at most 40 characters.")
  .regex(/^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u, "Use letters, spaces, apostrophes, dots or hyphens.");
const emergencyContactSchema = z.object({ name: nameField("contact's name", 120), relation: relationField, phone: phoneField }).strict();
/** Optional emergency contact: all blank → null; otherwise name, relation and phone are all required. */
const optionalEmergencyContact = z.preprocess(
  (v) => (v && typeof v === "object" && ["name", "relation", "phone"].every((k) => String((v as Record<string, unknown>)[k] ?? "").trim() === "") ? null : v),
  emergencyContactSchema.nullable(),
);

const optionalDate = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(isoDateSchema.nullable());
const optionalId = z
  .string()
  .trim()
  .max(64)
  .transform((v) => (v === "" ? null : v));

/** Staff date of birth: 1940 onwards (database CHECK); "before the joining date" is checked with the joining date. */
const employeeDob = isoDateSchema.refine((v) => v >= EARLIEST_DOB, "Check the date of birth.");

const personalFields = {
  firstName: nameField("first name"),
  middleName: optionalNameField("middle name"),
  lastName: optionalNameField("last name"),
  dob: employeeDob,
  gender: z.enum(GENDERS, "Choose a gender."),
};
const contactFields = {
  personalPhone: phoneField,
  workPhone: optionalPhoneField,
  personalEmail: optionalEmailField,
  workEmail: optionalEmailField,
  address: optionalAddress,
  emergencyContact: optionalEmergencyContact,
};

export const createEmployeeSchema = z
  .object({
    ...personalFields,
    ...contactFields,
    departmentId: idField,
    designationId: idField,
    appointmentType: z.enum(APPOINTMENT_TYPES, "Choose the appointment type."),
    joiningDate: isoDateSchema,
    confirmationDate: optionalDate,
    reportsToId: optionalId,
  })
  .strict();

/**
 * Field-level edits (M2): personal and contact sections. Employment changes (department, designation,
 * appointment type, reporting line, status) write service-history events and arrive with M4.
 */
export const updateEmployeePersonalSchema = z.object({ id: idField, version: versionField, ...personalFields }).strict();
export const updateEmployeeContactSchema = z.object({ id: idField, version: versionField, ...contactFields }).strict();

export const listEmployeesSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    staffType: z.enum(STAFF_TYPES).optional(),
    departmentId: idField.optional(),
    designationId: idField.optional(),
    status: z.enum(EMPLOYMENT_STATUSES).optional(),
    appointmentType: z.enum(APPOINTMENT_TYPES).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type UpdateEmployeePersonalInput = z.infer<typeof updateEmployeePersonalSchema>;
export type UpdateEmployeeContactInput = z.infer<typeof updateEmployeeContactSchema>;
export type ListEmployeesInput = z.infer<typeof listEmployeesSchema>;

// ───────────────────────────── Teacher profile (M3, H14) ─────────────────────────────

const YEAR_NOW = new Date().getUTCFullYear();
const optionalYear = z.preprocess(
  (v) => (typeof v === "string" ? (v.trim() === "" ? null : /^\d{4}$/.test(v.trim()) ? Number(v.trim()) : Number.NaN) : v),
  z.number("Use a 4-digit year.").int("Use a 4-digit year.").min(1950, "Use a year from 1950.").max(YEAR_NOW + 1, "Check the year.").nullable(),
);
const shortText = (label: string, max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().min(1, `Enter the ${label}.`).max(max, `Use at most ${max} characters.`))
    .refine((v) => !/[\p{Cc}​﻿]/u.test(v), "Remove control characters.");
const optionalShortText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().max(max, `Use at most ${max} characters.`))
    .refine((v) => !/[\p{Cc}​﻿]/u.test(v), "Remove control characters.")
    .transform((v) => (v === "" ? null : v));

export const qualificationSchema = z.object({ degree: shortText("degree", 80), subject: optionalShortText(80), institution: optionalShortText(120), year: optionalYear }).strict();
export const professionalQualificationSchema = z.object({ name: shortText("qualification", 80), year: optionalYear }).strict();

export const MAX_TEACHER_ENTRIES = 10;
export const teacherProfileSchema = z
  .object({
    employeeId: idField,
    /** null = the profile doesn't exist yet (create); otherwise the optimistic version. */
    version: versionField.nullable(),
    qualifications: z.array(qualificationSchema).max(MAX_TEACHER_ENTRIES, `At most ${MAX_TEACHER_ENTRIES} qualifications.`),
    professionalQualifications: z.array(professionalQualificationSchema).max(MAX_TEACHER_ENTRIES, `At most ${MAX_TEACHER_ENTRIES} professional qualifications.`),
    /** H14: free text until Phase 4 subjects; at most 10 × 60 characters, case-insensitively distinct. */
    specializations: z
      .array(shortText("subject", 60))
      .max(MAX_TEACHER_ENTRIES, `At most ${MAX_TEACHER_ENTRIES} subjects.`)
      .refine((a) => new Set(a.map((s) => s.toLowerCase())).size === a.length, "Each subject may appear only once."),
    experienceYearsBefore: z.preprocess(
      (v) => (typeof v === "string" ? (v.trim() === "" ? 0 : /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN) : v),
      z.number("Enter whole years from 0 to 60.").int("Enter whole years from 0 to 60.").min(0, "Enter whole years from 0 to 60.").max(60, "Enter whole years from 0 to 60."),
    ),
    teacherRegistrationNo: optionalShortText(40),
  })
  .strict();
export type TeacherProfileInput = z.infer<typeof teacherProfileSchema>;

// ───────────────────────────── Login account link (M3, H2) ─────────────────────────────

export const linkAccountSchema = z.object({ employeeId: idField, userId: idField }).strict();
export const unlinkAccountSchema = z.object({ employeeId: idField }).strict();
export type LinkAccountInput = z.infer<typeof linkAccountSchema>;

// ───────────────────────────── Lifecycle (M4a — H10–H13) ─────────────────────────────

const remarksField = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().max(500, "Use at most 500 characters."))
  .refine((v) => !/[\p{Cc}​﻿]/u.test(v), "Remove control characters.")
  .transform((v) => (v === "" ? null : v));
const reasonField = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(z.string().min(3, "Enter the reason (at least 3 characters).").max(500, "Use at most 500 characters."))
  .refine((v) => !/[\p{Cc}​﻿]/u.test(v), "Remove control characters.");

/** Department / designation / appointment type / confirmation — each change is one service event (H12). */
export const changeEmploymentSchema = z
  .object({
    id: idField,
    version: versionField,
    effectiveDate: isoDateSchema,
    departmentId: idField,
    designationId: idField,
    appointmentType: z.enum(APPOINTMENT_TYPES, "Choose the appointment type."),
    confirmationDate: optionalDate,
    remarks: remarksField,
  })
  .strict();

/** H10: reporting line (null = reports to nobody); cycles refused by the service under a lock. */
export const changeReportingSchema = z.object({ id: idField, version: versionField, reportsToId: optionalId, effectiveDate: isoDateSchema, remarks: remarksField }).strict();

/** H11/H13: leaving, long-term leave, rejoining; optional account deactivation for leavers. */
export const changeStatusSchema = z
  .object({
    id: idField,
    version: versionField,
    action: z.enum(STATUS_ACTIONS, "Choose what happened."),
    effectiveDate: isoDateSchema,
    reason: reasonField,
    deactivateAccount: z.boolean(),
  })
  .strict();

export type ChangeEmploymentInput = z.infer<typeof changeEmploymentSchema>;
export type ChangeReportingInput = z.infer<typeof changeReportingSchema>;
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
