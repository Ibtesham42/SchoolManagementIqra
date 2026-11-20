import { z } from "zod";
import { MONEY_RE } from "@/lib/money";
import { masterNameSchema } from "@/modules/hr/hr.schemas";
import { idField, versionField } from "@/modules/students/person.schemas";
import { feeCodeSchema } from "./setup.schemas";

/** Phase 5A-M3 concessions (FC6, maker-checker) and per-student charges (FC18). `.strict()`; amounts as strings. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const text = (min: number, max: number, what: string) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().min(min, `Say ${what} (at least ${min} characters).`).max(max, `Use at most ${max} characters.`))
    .refine((v) => !CONTROL.test(v), "Remove control characters.");

export const CONCESSION_KINDS = ["CONCESSION", "SCHOLARSHIP", "DISCOUNT", "WAIVER"] as const;
const name80 = masterNameSchema.refine((v) => [...v].length <= 80, "Use at most 80 characters.");
const concessionFields = {
  name: name80,
  kind: z.enum(CONCESSION_KINDS, "Choose the type."),
  calc: z.enum(["PERCENT", "FIXED"], "Choose a percentage or a fixed amount."),
  value: z.string().trim().regex(MONEY_RE, "Enter a number like 10 or 500.50."),
  categoryIds: z
    .array(idField)
    .min(1, "Choose at least one fee head.")
    .max(50)
    .refine((a) => new Set(a).size === a.length, "Each fee head once."),
};
const valueRule = <T extends { calc: string; value: string }>(v: T) => Number(v.value) > 0 && (v.calc !== "PERCENT" || Number(v.value) <= 100);
const valueIssue = { message: "Enter a value above zero (a percentage is at most 100).", path: ["value"] };

export const createConcessionSchema = z.object({ code: feeCodeSchema, ...concessionFields }).strict().refine(valueRule, valueIssue);
export const updateConcessionSchema = z.object({ id: idField, version: versionField, ...concessionFields }).strict().refine(valueRule, valueIssue);

export const proposeConcessionSchema = z
  .object({ studentId: idField, academicSessionId: idField, concessionId: idField, reason: text(3, 500, "why") })
  .strict();
export const decideConcessionSchema = z.object({ id: idField, version: versionField, decision: z.enum(["APPROVE", "REJECT"]) }).strict();
export const concessionRefSchema = z.object({ id: idField, version: versionField }).strict();

export const addChargeSchema = z
  .object({
    studentId: idField,
    academicSessionId: idField,
    installmentId: idField,
    categoryId: idField,
    amount: z.string().trim().regex(MONEY_RE, "Enter an amount like 500 or 500.50.").refine((v) => Number(v) > 0, "Enter an amount above zero."),
    note: text(2, 200, "what it is for"),
  })
  .strict();

export const enrollmentSearchSchema = z.object({ academicSessionId: idField, q: z.string().trim().min(2, "Type at least 2 characters.").max(100) }).strict();

export type CreateConcessionInput = z.infer<typeof createConcessionSchema>;
export type UpdateConcessionInput = z.infer<typeof updateConcessionSchema>;
export type ProposeConcessionInput = z.infer<typeof proposeConcessionSchema>;
export type DecideConcessionInput = z.infer<typeof decideConcessionSchema>;
export type ConcessionRefInput = z.infer<typeof concessionRefSchema>;
export type AddChargeInput = z.infer<typeof addChargeSchema>;
