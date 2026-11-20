import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 5A-M4 invoice generation and cancellation. `.strict()`. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const generateInvoicesSchema = z.object({ academicSessionId: idField, classId: idField, installmentId: idField }).strict();

export const cancelInvoiceSchema = z
  .object({
    id: idField,
    version: versionField,
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().min(3, "Say why (at least 3 characters).").max(500, "Use at most 500 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters."),
  })
  .strict();

export type GenerateInvoicesInput = z.infer<typeof generateInvoicesSchema>;
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;
