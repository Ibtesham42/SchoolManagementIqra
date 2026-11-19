import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 3C-M3 payroll runs. `.strict()`. */
export const createRunSchema = z.object({ month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.") }).strict();
export const runRefSchema = z.object({ id: idField, version: versionField }).strict();

export const reopenRunSchema = z
  .object({
    id: idField,
    version: versionField,
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().min(3, "Say why the payroll is reopened.").max(300, "Use at most 300 characters."))
      .refine((v) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\uFEFF]/.test(v), "Remove control characters."),
  })
  .strict();

export type ReopenRunInput = z.infer<typeof reopenRunSchema>;
export type CreateRunInput = z.infer<typeof createRunSchema>;
export type RunRefInput = z.infer<typeof runRefSchema>;
