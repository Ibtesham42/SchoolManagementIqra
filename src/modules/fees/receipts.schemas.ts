import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 5B-M3 receipts: lookup and cancellation (FC13). `.strict()`; the service re-checks everything. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const cancelReceiptSchema = z
  .object({
    id: idField,
    version: versionField,
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().min(5, "Say why (at least 5 characters).").max(500, "Use at most 500 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters."),
  })
  .strict();

/** Exact receipt number (as printed); spaces removed. The service also tries it upper-cased. */
export const receiptLookupSchema = z
  .object({
    receiptNo: z
      .string()
      .transform((v) => v.normalize("NFKC").trim().replace(/\s+/g, ""))
      .pipe(z.string().min(2, "Type the receipt number.").max(40, "Receipt numbers have at most 40 characters.")),
  })
  .strict();

export const receiptListSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(1000).default(1),
  })
  .strict();

export type CancelReceiptInput = z.infer<typeof cancelReceiptSchema>;
export type ReceiptLookupInput = z.infer<typeof receiptLookupSchema>;
