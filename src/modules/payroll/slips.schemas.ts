import { z } from "zod";
import { idField, isoDateSchema } from "@/modules/students/person.schemas";
import { AMOUNT_RE } from "./structures.schemas";

/** Phase 3C-M5 adjustments (P10), payments (P13). `.strict()`. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;
const amount = z.string().trim().regex(AMOUNT_RE, "Enter an amount like 1500 or 1500.50.").refine((v) => Number(v) > 0, "Enter more than zero.");
const text = (min: number, max: number, label: string) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
    .pipe(z.string().min(min, `Enter ${label}.`).max(max, `Use at most ${max} characters.`))
    .refine((v) => !CONTROL.test(v), "Remove control characters.");

export const ADJUSTMENT_KINDS = ["BONUS", "ARREARS", "OTHER_EARNING", "OTHER_DEDUCTION"] as const;
export const addAdjustmentSchema = z.object({ slipId: idField, kind: z.enum(ADJUSTMENT_KINDS, "Choose a kind."), amount, note: text(3, 500, "a note") }).strict();
export const adjustmentRefSchema = z.object({ id: idField }).strict();

export const PAYMENT_METHODS = ["BANK_TRANSFER", "CHEQUE", "CASH", "UPI"] as const;
const reference = z
  .string()
  .transform((v) => v.trim())
  .pipe(z.string().max(48, "Use at most 48 characters.").regex(/^[A-Za-z0-9/._-]*$/, "Use letters, digits and / . _ - only."))
  .transform((v) => (v === "" ? null : v));

export const recordPaymentSchema = z
  .object({ slipId: idField, amount, method: z.enum(PAYMENT_METHODS, "Choose how it was paid."), reference, paidOn: isoDateSchema })
  .strict()
  .refine((v) => v.method === "CASH" || v.reference !== null, { message: "Enter the bank / UPI / cheque reference.", path: ["reference"] });

/** Pay every unpaid balance of an approved run at once (one batch reference; each slip gets "<batch>/<slip no>"). */
export const bulkPaymentSchema = z
  .object({ runId: idField, method: z.enum(PAYMENT_METHODS), reference, paidOn: isoDateSchema })
  .strict()
  .refine((v) => v.method === "CASH" || v.reference !== null, { message: "Enter the batch reference.", path: ["reference"] });

export type AddAdjustmentInput = z.infer<typeof addAdjustmentSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type BulkPaymentInput = z.infer<typeof bulkPaymentSchema>;
