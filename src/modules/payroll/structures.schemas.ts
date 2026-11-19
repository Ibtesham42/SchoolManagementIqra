import { z } from "zod";
import { masterCodeSchema, masterNameSchema } from "@/modules/hr/hr.schemas";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 3C-M2 salary components and structures (PHASE_3C_PLAN.md P1, P2). `.strict()`. Amounts as decimal strings. */
const bool = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
export const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;
const amount = z.string().trim().regex(AMOUNT_RE, "Enter an amount like 1500 or 1500.50.");

export const COMPONENT_KINDS = ["EARNING", "DEDUCTION"] as const;
export const COMPONENT_CALCS = ["FIXED", "PERCENT_OF_BASIC"] as const;

const componentFields = {
  code: masterCodeSchema,
  name: masterNameSchema,
  kind: z.enum(COMPONENT_KINDS, "Choose earning or deduction."),
  calc: z.enum(COMPONENT_CALCS, "Choose a fixed amount or a percentage of basic."),
  prorated: bool,
};
export const createComponentSchema = z.object(componentFields).strict();
export const updateComponentSchema = z.object({ id: idField, version: versionField, ...componentFields }).strict();
export const setActiveSchema = z.object({ id: idField, version: versionField, active: z.boolean() }).strict();

export const structureItemSchema = z.object({ componentId: idField, value: amount }).strict();
const structureFields = {
  name: masterNameSchema,
  items: z
    .array(structureItemSchema)
    .max(30, "Use at most 30 components.")
    .refine((a) => new Set(a.map((i) => i.componentId)).size === a.length, "Each component may appear only once."),
};
export const createStructureSchema = z.object(structureFields).strict();
export const updateStructureSchema = z.object({ id: idField, version: versionField, ...structureFields }).strict();

export type CreateComponentInput = z.infer<typeof createComponentSchema>;
export type UpdateComponentInput = z.infer<typeof updateComponentSchema>;
export type SetActiveInput = z.infer<typeof setActiveSchema>;
export type CreateStructureInput = z.infer<typeof createStructureSchema>;
export type UpdateStructureInput = z.infer<typeof updateStructureSchema>;
