import { z } from "zod";

/** Phase 6A-M3 — the public /activate form (ADR-046). Validated on the server; one generic error for every mismatch. */
export const activateAccountSchema = z
  .object({
    username: z.string().trim().toLowerCase().min(1).max(100),
    code: z.string().trim().min(1).max(40),
    dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    consent: z.literal(true),
    newPassword: z.string().min(1).max(128),
    confirmPassword: z.string().min(1).max(128),
  })
  .strict();
export type ActivateAccountInput = z.infer<typeof activateAccountSchema>;
