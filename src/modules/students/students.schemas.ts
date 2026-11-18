import { z } from "zod";
import { addressSchema } from "@/modules/settings/settings.schemas";
import { cleanText } from "./person-fields";
import {
  dobField,
  GENDERS,
  idField as id,
  isoDateSchema,
  nameField,
  optionalEmailField,
  optionalNameField,
  optionalPhoneField,
  optionalTextField,
  phoneField,
  versionField as version,
} from "./person.schemas";
import { LEAVING_STATUSES, STUDENT_STATUSES } from "./students.rules";

/**
 * Student-record input (design §5.1, slice S7). `.strict()` everywhere: permanent identifiers (student ID,
 * admission number), status and enrollment are not fields of the edit schemas, so a crafted request that
 * sends them is refused. Identity fields are optional — a class teacher's form doesn't send them; the
 * service still refuses any change outside the caller's field allowance.
 */
export const listStudentsSchema = z
  .object({
    academicSessionId: id.optional(),
    classId: id.optional(),
    sectionId: id.optional(),
    status: z.enum(STUDENT_STATUSES).optional(),
    q: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ListStudentsInput = z.infer<typeof listStudentsSchema>;

/** Export uses the directory filters (no paging — the service refuses more than EXPORT_MAX_ROWS). */
export const exportStudentsSchema = listStudentsSchema.omit({ page: true, pageSize: true });
export type ExportStudentsInput = z.infer<typeof exportStudentsSchema>;

export const updateStudentSchema = z
  .object({
    id,
    version,
    firstName: nameField("first name").optional(),
    middleName: optionalNameField("middle name").optional(),
    lastName: optionalNameField("last name").optional(),
    dob: dobField.optional(),
    gender: z.enum(GENDERS, "Choose the gender.").optional(),
    phone: optionalPhoneField,
    email: optionalEmailField,
    address: addressSchema,
  })
  .strict();
export type UpdateStudentInput = z.infer<typeof updateStudentSchema>;

export const updateGuardianSchema = z
  .object({
    studentId: id,
    guardianId: id,
    name: nameField("name", 120).optional(),
    occupation: optionalTextField(80).optional(),
    phone: phoneField,
    altPhone: optionalPhoneField,
    email: optionalEmailField,
  })
  .strict();
export type UpdateGuardianInput = z.infer<typeof updateGuardianSchema>;

export const changeStatusSchema = z
  .object({
    id,
    version,
    toStatus: z.enum(LEAVING_STATUSES, "Choose what happened."),
    effectiveDate: isoDateSchema,
    reason: z
      .string()
      .transform(cleanText)
      .pipe(z.string().min(3, "Enter the reason (at least 3 characters).").max(500, "Use at most 500 characters.")),
  })
  .strict();
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;
