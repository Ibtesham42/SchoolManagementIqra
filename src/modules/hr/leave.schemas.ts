import { z } from "zod";
import {
  idField,
  isoDateSchema,
  versionField,
} from "@/modules/students/person.schemas";
import { masterCodeSchema, masterNameSchema } from "./hr.schemas";
import { HOLIDAY_APPLIES_TO, LEAVE_APPLIES_TO, parseDays } from "./leave.rules";

/**
 * Phase 3B input (PHASE_3B_PLAN.md, L1–L12). `.strict()` everywhere; the services re-check everything that depends on
 * the database (uniqueness, active types, session bounds, versions).
 */

/** Days typed in a form: "", "12" or "7.5" (half days). Blank → null where a value is optional. */
const daysField = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, c) => {
      const d = parseDays(v);
      if (!d) {
        c.addIssue({
          code: "custom",
          message: `Enter ${label} in whole or half days (0–366).`,
        });
        return z.NEVER;
      }
      return d.toString();
    });
const optionalDaysField = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, c) => {
      if (v === "") return null;
      const d = parseDays(v);
      if (!d) {
        c.addIssue({
          code: "custom",
          message: `Enter ${label} in whole or half days (0–366), or leave it empty.`,
        });
        return z.NEVER;
      }
      return d.toString();
    });
const bool = z.preprocess(
  (v) => v === true || v === "on" || v === "true",
  z.boolean(),
);

const leaveTypeFields = {
  code: masterCodeSchema,
  name: masterNameSchema,
  isPaid: bool,
  annualQuota: optionalDaysField("the yearly quota"),
  allowHalfDay: bool,
  carryForwardMax: daysField("the carry-forward limit"),
  appliesTo: z.enum(LEAVE_APPLIES_TO, "Choose who can use this leave type."),
};
const leaveTypeRules = <T extends { isPaid: boolean; carryForwardMax: string }>(
  s: z.ZodType<T>,
) =>
  s.refine((v) => v.isPaid || v.carryForwardMax === "0", {
    message: "Unpaid leave can't be carried forward.",
    path: ["carryForwardMax"],
  });

export const createLeaveTypeSchema = leaveTypeRules(
  z.object(leaveTypeFields).strict(),
);
export const updateLeaveTypeSchema = leaveTypeRules(
  z.object({ id: idField, version: versionField, ...leaveTypeFields }).strict(),
);
export const setLeaveTypeActiveSchema = z
  .object({ id: idField, version: versionField, active: z.boolean() })
  .strict();

const holidayName = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(2, "Enter the holiday's name.")
      .max(80, "Use at most 80 characters."),
  )
  .refine((v) => !/[\p{Cc}​﻿]/u.test(v), "Remove control characters.");
export const createHolidaySchema = z
  .object({
    date: isoDateSchema,
    name: holidayName,
    appliesTo: z.enum(HOLIDAY_APPLIES_TO, "Choose who the holiday applies to."),
  })
  .strict();
export const holidayRefSchema = z.object({ id: idField }).strict();
export const listHolidaysSchema = z
  .object({ academicSessionId: idField })
  .strict();

/** L1: opening balance for one employee × leave type × academic session (HR, audited). */
export const openingBalanceSchema = z
  .object({
    employeeId: idField,
    leaveTypeId: idField,
    academicSessionId: idField,
    /** null = the balance doesn't exist yet. */
    version: versionField.nullable(),
    allotted: daysField("the allotted days"),
    carriedForward: daysField("the carried-forward days"),
  })
  .strict();

/** L3: weekly off as sent by the settings form (checkbox values). */
export const weeklyOffFormSchema = z
  .object({
    days: z
      .array(z.coerce.number().int().min(0).max(6))
      .max(6, "At least one day of the week must be a working day."),
    saturdays: z.array(z.coerce.number().int().min(1).max(5)).max(5),
  })
  .strict();

export type CreateLeaveTypeInput = z.infer<typeof createLeaveTypeSchema>;
export type UpdateLeaveTypeInput = z.infer<typeof updateLeaveTypeSchema>;
export type SetLeaveTypeActiveInput = z.infer<typeof setLeaveTypeActiveSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type OpeningBalanceInput = z.infer<typeof openingBalanceSchema>;
