import { z } from "zod";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";
import { MANUAL_STATUSES, MONTH_RE, TIME_RE } from "./staff-attendance.rules";

/** Phase 3B M4 input (L7, L8). `.strict()`; the service re-checks everything that depends on the database. */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;

const optionalTime = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().regex(TIME_RE, "Use a time like 09:05.").nullable());

export const markEntrySchema = z
  .object({
    employeeId: idField,
    status: z.enum(MANUAL_STATUSES, "Choose present, absent, late or half day."),
    checkIn: optionalTime,
    checkOut: optionalTime,
    /** null = the screen showed no saved row for this employee. */
    version: versionField.nullable(),
  })
  .strict()
  .refine((e) => e.status !== "ABSENT" || (e.checkIn === null && e.checkOut === null), {
    message: "An absent day has no check-in or check-out time.",
    path: ["checkIn"],
  })
  .refine((e) => e.checkIn === null || e.checkOut === null || e.checkOut >= e.checkIn, {
    message: "Check-out can't be before check-in.",
    path: ["checkOut"],
  });

/** One day, many employees (L7: one batched transaction per screen). Reason only needed for corrections (L8). */
export const markDaySchema = z
  .object({
    date: isoDateSchema,
    entries: z.array(markEntrySchema).min(1, "Nobody to mark on this screen.").max(500, "Mark at most 500 staff at once."),
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/[ \t]+/g, " "))
      .pipe(z.string().max(500, "Use at most 500 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters.")
      .refine((v) => v === "" || v.length >= 3, "Say briefly why the saved marks are changed."),
  })
  .strict()
  .refine((v) => new Set(v.entries.map((e) => e.employeeId)).size === v.entries.length, {
    message: "Each employee may appear only once.",
    path: ["entries"],
  });

const optionalId = z
  .string()
  .trim()
  .max(64)
  .transform((v) => (v === "" ? null : v));

export const attendanceDayQuerySchema = z
  .object({ date: isoDateSchema, departmentId: optionalId.default("") })
  .strict();

const monthField = z.string().trim().regex(MONTH_RE, "Use a month like 2026-11.");

export const attendanceRegisterSchema = z
  .object({
    month: monthField,
    departmentId: optionalId.default(""),
    page: z.coerce.number().int().min(1).max(1000).default(1),
  })
  .strict();

export const employeeMonthSchema = z.object({ employeeId: idField, month: monthField }).strict();

export type MarkEntryInput = z.infer<typeof markEntrySchema>;
export type MarkDayInput = z.infer<typeof markDaySchema>;
export type AttendanceDayQuery = z.infer<typeof attendanceDayQuerySchema>;
export type AttendanceRegisterInput = z.infer<typeof attendanceRegisterSchema>;
export type EmployeeMonthInput = z.infer<typeof employeeMonthSchema>;

/** 3B-M5 payroll summary (page) and its CSV export (whole month, optional department). */
export const payrollSummarySchema = attendanceRegisterSchema;
export const payrollSummaryExportSchema = z.object({ month: monthField, departmentId: optionalId.default("") }).strict();
export type PayrollSummaryInput = z.infer<typeof payrollSummarySchema>;
export type PayrollSummaryExportInput = z.infer<typeof payrollSummaryExportSchema>;
