import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/**
 * Phase 3C (P8): optional PAN and bank details. Blank = keep what is saved; "remove" clears it. `.strict()`.
 * Formats: PAN `AAAAA9999A`; account 9–18 digits; IFSC `AAAA0XXXXXX` (DB CHECK too); name 2–120 characters.
 */
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const ACCOUNT_RE = /^[0-9]{9,18}$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const CONTROL = /[\u0000-\u001F\u007F​﻿]/;
const bool = z.preprocess((v) => v === true || v === "on" || v === "true", z.boolean());
const opt = (re: RegExp, message: string, clean: (v: string) => string) =>
  z
    .string()
    .transform((v) => clean(v))
    .pipe(z.union([z.literal(""), z.string().regex(re, message)]))
    .transform((v) => (v === "" ? null : v));

export const updateBankDetailsSchema = z
  .object({
    employeeId: idField,
    version: versionField,
    pan: opt(PAN_RE, "Enter a PAN like ABCDE1234F.", (v) => v.replace(/\s+/g, "").toUpperCase()),
    bankAccount: opt(ACCOUNT_RE, "Enter the account number (9–18 digits).", (v) => v.replace(/[\s-]+/g, "")),
    bankIfsc: opt(IFSC_RE, "Enter an IFSC like SBIN0001234.", (v) => v.replace(/\s+/g, "").toUpperCase()),
    bankAccountName: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.union([z.literal(""), z.string().min(2, "Enter the name on the account.").max(120, "Use at most 120 characters.")]))
      .refine((v) => !CONTROL.test(v), "Remove control characters.")
      .transform((v) => (v === "" ? null : v)),
    removePan: bool,
    removeBank: bool,
  })
  .strict()
  .refine((v) => !(v.removePan && v.pan !== null), { message: "Either enter a PAN or remove it, not both.", path: ["pan"] })
  // Review P8 L1: a new account number comes with its IFSC and account name (it may be at another bank).
  .refine((v) => v.bankAccount === null || (v.bankIfsc !== null && v.bankAccountName !== null), {
    message: "Enter the IFSC and the name on the account together with a new account number.",
    path: ["bankIfsc"],
  })
  .refine((v) => !(v.removeBank && (v.bankAccount !== null || v.bankIfsc !== null || v.bankAccountName !== null)), {
    message: "Either enter bank details or remove them, not both.",
    path: ["bankAccount"],
  });

export type UpdateBankDetailsInput = z.infer<typeof updateBankDetailsSchema>;

/** "ABCDE1234F" → "XXXXXX234F"; "123456789012" → "XXXXXXXX9012". */
export function maskEnd(value: string, visible = 4): string {
  return value.length <= visible ? "X".repeat(value.length) : "X".repeat(value.length - visible) + value.slice(-visible);
}
