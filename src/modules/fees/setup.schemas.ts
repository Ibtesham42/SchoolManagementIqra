import { z } from "zod";
import { MONEY_RE } from "@/lib/money";
import { masterNameSchema } from "@/modules/hr/hr.schemas";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 5A-M2 fee setup (PHASE_5_PLAN.md FC2, FC3, FC5, FC7, FC12). `.strict()`; amounts as decimal strings. */
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.");
const amount = z.string().trim().regex(MONEY_RE, "Enter an amount like 1500 or 1500.50.");
const positiveAmount = amount.refine((v) => Number(v) > 0, "Enter an amount above zero.");

/** Same rule as the database CHECK: 2–20 of A–Z 0–9 _ -, starting and ending with a letter or digit. */
export const feeCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9](?:[A-Z0-9_-]{0,18}[A-Z0-9])$/, "Use 2–20 English letters or digits (hyphen or underscore inside), e.g. TUITION.")
  // Review 5B-M1 L5: codes the fee services use for their own system heads.
  .refine((v) => !["LATE_FEE", "TRANSPORT", "OPENING_BALANCE"].includes(v), "This code is reserved for the system.");

const shortName = (max: number) => masterNameSchema.refine((v) => [...v].length <= max, `Use at most ${max} characters.`);

/** Kinds the school creates; TRANSPORT / LATE_FEE / OPENING_BALANCE are system kinds created by the fee services. */
export const SCHOOL_CATEGORY_KINDS = ["REGULAR", "ONE_TIME", "OTHER"] as const;
export const APPLIES_TO = ["ALL", "NEW_ADMISSION", "EXISTING"] as const;

export const createCategorySchema = z
  .object({ code: feeCodeSchema, name: shortName(80), kind: z.enum(SCHOOL_CATEGORY_KINDS, "Choose the type."), appliesTo: z.enum(APPLIES_TO, "Choose who pays it.") })
  .strict();
export const updateCategorySchema = z
  .object({ id: idField, version: versionField, name: shortName(80), appliesTo: z.enum(APPLIES_TO, "Choose who pays it.") })
  .strict();
export const setActiveSchema = z.object({ id: idField, version: versionField, active: z.boolean() }).strict();

export const createInstallmentSchema = z
  .object({ academicSessionId: idField, name: shortName(60), dueOn: isoDate, sortOrder: z.coerce.number().int().min(0).max(999) })
  .strict();
export const updateInstallmentSchema = z
  .object({ id: idField, version: versionField, name: shortName(60), dueOn: isoDate, sortOrder: z.coerce.number().int().min(0).max(999) })
  .strict();
export const refSchema = z.object({ id: idField, version: versionField }).strict();

export const structureItemSchema = z.object({ categoryId: idField, installmentId: idField, amount }).strict();
const structureItems = z
  .array(structureItemSchema)
  .min(1, "Add at least one amount.")
  .max(400, "Use at most 400 amounts.")
  .refine((a) => new Set(a.map((i) => `${i.categoryId}|${i.installmentId}`)).size === a.length, "Each fee head may appear once per installment.");
export const createStructureSchema = z.object({ academicSessionId: idField, classId: idField, name: shortName(80), items: structureItems }).strict();
export const updateStructureSchema = z.object({ id: idField, version: versionField, name: shortName(80), items: structureItems }).strict();
export const copyStructureSchema = z.object({ id: idField, name: shortName(80) }).strict();

export const LATE_FEE_CALCS = ["FLAT", "PER_DAY", "PERCENT"] as const;
export const setLateFeeRuleSchema = z
  .object({
    academicSessionId: idField,
    graceDays: z.coerce.number().int().min(0, "0 or more days.").max(365, "At most 365 days."),
    calc: z.enum(LATE_FEE_CALCS, "Choose how the late fee is charged."),
    value: positiveAmount,
    cap: positiveAmount.nullable(),
  })
  .strict()
  .refine((v) => v.calc !== "PERCENT" || Number(v.value) <= 100, { message: "A percentage is at most 100.", path: ["value"] })
  .refine((v) => v.calc !== "PER_DAY" || v.cap !== null, { message: "A per-day late fee needs a maximum.", path: ["cap"] });
export const clearLateFeeRuleSchema = z.object({ academicSessionId: idField }).strict();

export const feeNumberFormatsSchema = z
  .object({ feeReceipt: z.string().trim().min(1, "Enter the receipt number format.").max(40), feeInvoice: z.string().trim().min(1, "Enter the invoice number format.").max(40) })
  .strict();

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type SetActiveInput = z.infer<typeof setActiveSchema>;
export type CreateInstallmentInput = z.infer<typeof createInstallmentSchema>;
export type UpdateInstallmentInput = z.infer<typeof updateInstallmentSchema>;
export type RefInput = z.infer<typeof refSchema>;
export type CreateStructureInput = z.infer<typeof createStructureSchema>;
export type UpdateStructureInput = z.infer<typeof updateStructureSchema>;
export type CopyStructureInput = z.infer<typeof copyStructureSchema>;
export type SetLateFeeRuleInput = z.infer<typeof setLateFeeRuleSchema>;
export type FeeNumberFormatsInput = z.infer<typeof feeNumberFormatsSchema>;
