import { z } from "zod";
import { MONEY_RE } from "@/lib/money";
import { idField, isoDateSchema, versionField } from "@/modules/students/person.schemas";

/**
 * Phase 6C-M3 (P19) — a parent's UPI / bank-transfer intimation and the office's decision. `.strict()`; amounts as
 * strings (decimal.js in the service). The service re-checks everything (dues, reference, dates, who may decide).
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​﻿]/;

export const CLAIM_METHODS = ["UPI", "BANK_TRANSFER"] as const;
export type ClaimMethod = (typeof CLAIM_METHODS)[number];

export const submitClaimSchema = z
  .object({
    studentId: idField,
    amount: z.string().trim().regex(MONEY_RE, "Enter an amount like 1500 or 1500.50.").refine((v) => Number(v) > 0, "Enter an amount above zero."),
    method: z.enum(CLAIM_METHODS, "Choose how you paid."),
    transactionRef: z.string().trim().min(1, "Enter the transaction reference.").max(60, "Use at most 60 characters."),
    paidOn: isoDateSchema,
  })
  .strict();

export const claimRefSchema = z.object({ id: idField, version: versionField }).strict();

export const rejectClaimSchema = z
  .object({
    id: idField,
    version: versionField,
    reason: z
      .string()
      .transform((v) => v.normalize("NFC").trim().replace(/\s+/g, " "))
      .pipe(z.string().min(3, "Say why (at least 3 characters).").max(300, "Use at most 300 characters."))
      .refine((v) => !CONTROL.test(v), "Remove control characters."),
  })
  .strict();

export type SubmitClaimInput = z.infer<typeof submitClaimSchema>;
export type ClaimRefInput = z.infer<typeof claimRefSchema>;
export type RejectClaimInput = z.infer<typeof rejectClaimSchema>;

/**
 * Review 6C-M3 M1: the counter keeps letters in UPI / bank references ("UTR123456789012"), a claim stores the bare
 * canonical form. A live receipt "has" a claim's reference when its reference IS it or ENDS with it.
 */
export const liveReceiptRefWhere = (ref: string) => ({
  status: "SUCCESS" as const,
  method: { in: ["UPI" as const, "BANK_TRANSFER" as const] },
  transactionRef: { endsWith: ref },
});

/**
 * The canonical claim reference: the counter's normalisation (upper case, letters and digits), then stricter shapes —
 * a UPI transaction reference (UTR / RRN) is 12 digits; a bank transfer reference 6–30 letters and digits. A confirmed
 * receipt carries this string; receipts recorded at the counter may carry it with a prefix — see liveReceiptRefWhere
 * (an unindexed suffix match over live UPI / bank receipts: bounded by the school's size; a short bank reference may
 * match another receipt's tail, which refuses the claim — the parent is sent to the office, never double-credited).
 */
export function canonicalClaimRef(method: ClaimMethod, raw: string): string | null {
  const v = raw.normalize("NFKC").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (method === "UPI") return /^\d{12}$/.test(v) ? v : null;
  return /^[A-Z0-9]{6,30}$/.test(v) ? v : null;
}
