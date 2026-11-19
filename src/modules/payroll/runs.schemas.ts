import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 3C-M3 payroll runs. `.strict()`. */
export const createRunSchema = z.object({ month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.") }).strict();
export const runRefSchema = z.object({ id: idField, version: versionField }).strict();

export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunRefInput = z.infer<typeof runRefSchema>;
