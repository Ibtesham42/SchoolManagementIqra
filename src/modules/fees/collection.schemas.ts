import { z } from "zod";
import { MONEY_RE } from "@/lib/money";
import { idField } from "@/modules/students/person.schemas";

/** Phase 5B-M1 counter collection (FC8–FC11, FC15). `.strict()`; amounts as strings; the service re-checks everything. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
// Review 5B-M1 L4: a real calendar date ("2026-02-31" is refused, never rolled over).
const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date.")
  .refine((v) => {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }, "Choose a real date.");
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const optionalText = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().max(max, `Use at most ${max} characters.`))
    .refine((v) => !CONTROL.test(v), "Remove control characters.")
    .transform((v) => (v === "" ? null : v));

export const PAYMENT_METHODS = ["CASH", "UPI", "BANK_TRANSFER", "CHEQUE", "CARD"] as const;

export const collectSchema = z
  .object({
    studentId: idField,
    amount: z.string().trim().regex(MONEY_RE, "Enter an amount like 1500 or 1500.50.").refine((v) => Number(v) > 0, "Enter an amount above zero."),
    method: z.enum(PAYMENT_METHODS, "Choose how it was paid."),
    transactionRef: optionalText(60),
    bankName: optionalText(80),
    instrumentDate: isoDate.nullable(),
    paidOn: isoDate,
    /** Limit the payment to these invoices (oldest due first among them). Empty = all open invoices. */
    invoiceIds: z.array(idField).max(100).default([]),
    /** Late fees on these invoices are waived (needs fee.concession.manage and a reason). */
    waiveLateFeeInvoiceIds: z.array(idField).max(100).default([]),
    waiveReason: optionalText(300),
    /** Random key placed in the form when it was rendered (FC15): a double submit gives one receipt. */
    idempotencyKey: z.string().regex(/^[A-Za-z0-9-]{16,64}$/, "Reload the page and try again."),
  })
  .strict()
  .refine((v) => v.method === "CASH" || v.transactionRef !== null, { message: "Enter the transaction / cheque / card reference.", path: ["transactionRef"] })
  .refine((v) => v.method !== "CHEQUE" || (v.bankName !== null && v.instrumentDate !== null), { message: "Enter the bank and the cheque date.", path: ["bankName"] })
  // Review L4: no post-dated or stale cheques (dated within the 90 days up to the payment date).
  .refine((v) => v.method !== "CHEQUE" || v.instrumentDate === null || (dayDiff(v.paidOn, v.instrumentDate) >= 0 && dayDiff(v.paidOn, v.instrumentDate) <= 90), { message: "The cheque date must be on or before the payment date and within 90 days of it.", path: ["instrumentDate"] })
  .refine((v) => v.waiveLateFeeInvoiceIds.length === 0 || (v.waiveReason !== null && v.waiveReason.length >= 3), { message: "Say why the late fee is waived.", path: ["waiveReason"] });

export const collectionSearchSchema = z.object({ q: z.string().trim().min(2, "Type at least 2 characters.").max(100) }).strict();

export type CollectInput = z.infer<typeof collectSchema>;
