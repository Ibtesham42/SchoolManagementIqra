import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";
import { AMOUNT_RE } from "./structures.schemas";

/** Phase 3C-M2 employee salaries — maker-checker (PHASE_3C_PLAN.md P7). `.strict()`. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;
const note = z
  .string()
  .transform((v) => v.normalize("NFC").trim().replace(/[ \t]+/g, " "))
  .pipe(z.string().max(500, "Use at most 500 characters."))
  .refine((v) => !CONTROL.test(v), "Remove control characters.");

export const proposeSalarySchema = z
  .object({
    employeeId: idField,
    structureId: idField,
    basic: z.string().trim().regex(AMOUNT_RE, "Enter the monthly basic like 25000 or 25000.50."),
    /** "YYYY-MM": the salary applies from the first day of this month. */
    effectiveFrom: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the month it applies from."),
  })
  .strict();

export const decideSalarySchema = z
  .object({ id: idField, version: versionField, decision: z.enum(["APPROVE", "REJECT"]), note })
  .strict()
  .refine((v) => v.decision === "APPROVE" || v.note.length >= 3, { message: "Say why the proposal is rejected.", path: ["note"] });

export const salaryRefSchema = z.object({ id: idField, version: versionField }).strict();

export type ProposeSalaryInput = z.infer<typeof proposeSalarySchema>;
export type DecideSalaryInput = z.infer<typeof decideSalarySchema>;
export type SalaryRefInput = z.infer<typeof salaryRefSchema>;
