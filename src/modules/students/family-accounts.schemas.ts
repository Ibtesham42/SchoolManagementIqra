import { z } from "zod";
import { USERNAME_PATTERN } from "@/modules/identity/identity.schemas";

/** Phase 6A-M3 — office forms for parent portal accounts (ADR-046). `.strict()`, validated on the server. */
const id = z.string().min(1).max(64);
const optionalUsername = z
  .string()
  .trim()
  .toLowerCase()
  .max(50)
  .transform((v) => (v === "" ? null : v))
  .pipe(z.string().regex(USERNAME_PATTERN, "3–50 characters: letters, digits, dot, dash or underscore.").nullable());

/** One guardian's slip: "create" (new account) or "reset" (new code; the old password stops working). */
export const guardianSlipSchema = z.object({ studentId: id, guardianId: id, mode: z.enum(["create", "reset"]), username: optionalUsername.default(null) }).strict();
export type GuardianSlipInput = z.infer<typeof guardianSlipSchema>;

/** Phase 6A-M3b: an emailed invitation (create the account if needed, or a new code for one never activated). */
export const guardianInvitationSchema = z.object({ studentId: id, guardianId: id, username: optionalUsername.default(null) }).strict();

/** A section's slips: accounts for primary guardians without one; optionally new codes for accounts not activated yet. */
export const sectionSlipsSchema = z.object({ sectionId: id, reissuePending: z.boolean().default(false) }).strict();
export type SectionSlipsInput = z.infer<typeof sectionSlipsSchema>;

export const portalAccessSchema = z.object({ studentId: id, guardianId: id, portalAccess: z.boolean() }).strict();
export const familyAccountActiveSchema = z.object({ studentId: id, guardianId: id, active: z.boolean(), reason: z.string().trim().min(3, "Give a short reason.").max(300) }).strict();

/** Phase 6C-M4 (P14): a student's own portal account — the slip is handed to the parent (DPDP: parental consent). */
export const studentSlipSchema = z.object({ studentId: id, mode: z.enum(["create", "reset"]), username: optionalUsername.default(null) }).strict();
export type StudentSlipInput = z.infer<typeof studentSlipSchema>;
export const studentAccountActiveSchema = z.object({ studentId: id, active: z.boolean(), reason: z.string().trim().min(3, "Give a short reason.").max(300) }).strict();
