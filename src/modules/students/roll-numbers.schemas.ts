import { z } from "zod";

/** Roll-number actions (D3). The services re-check status, versions and the confirmation under lock. */
const id = z.string().trim().min(1).max(64);
const toInt = (v: unknown) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v);
const version = z.preprocess(toInt, z.number("Reload the page and try again.").int().min(1, "Reload the page and try again."));

export const generateRollSchema = z
  .object({ sectionId: id, version: z.preprocess((v) => (v === "" || v === undefined ? null : toInt(v)), z.number().int().min(1).nullable()) })
  .strict();
export const finalizeRollSchema = z.object({ sectionId: id, version, confirm: z.string().trim().min(1, "Type the section code to confirm.").max(32) }).strict();
export const correctRollSchema = z
  .object({
    sectionId: id,
    enrollmentId: id,
    version,
    rollNumber: z.preprocess(toInt, z.number("Enter a whole number.").int("Enter a whole number.").min(1, "Use 1 or more.").max(999, "Use at most 999.")),
    reason: z
      .string()
      .transform((v) => v.trim().replace(/\s+/g, " "))
      .pipe(z.string().min(3, "Give the reason (at least 3 characters).").max(500, "Use at most 500 characters.")),
  })
  .strict();
