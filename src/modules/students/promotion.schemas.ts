import { z } from "zod";
import { LEAVING_STATUSES } from "./students.rules";
import { idField, versionField } from "./person.schemas";

/** Phase 4C-M1 promotion (PHASE_4_PLAN.md AC16). `.strict()`. */
const optionalId = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : v))
  .pipe(idField.nullable());

export const proposePromotionsSchema = z
  .object({
    sectionId: idField,
    entries: z
      .array(
        z
          .object({
            enrollmentId: idField,
            decision: z.enum(["PROMOTE", "DETAIN", "LEAVE"], "Choose promote, detain or leave."),
            toClassId: optionalId,
            leaveAs: z
              .string()
              .trim()
              .transform((v) => (v === "" ? null : v))
              .pipe(z.enum(LEAVING_STATUSES, "Choose transferred, withdrawn or graduated.").nullable()),
            version: versionField.nullable(),
          })
          .strict(),
      )
      .min(1, "Nobody to save.")
      .max(200, "A section has at most 200 students."),
  })
  .strict()
  .refine((v) => new Set(v.entries.map((e) => e.enrollmentId)).size === v.entries.length, { message: "Each student may appear only once.", path: ["entries"] });

export const confirmPromotionsSchema = z
  .object({
    sectionId: idField,
    targetSessionId: idField,
    /** For each target class, the section in the target session that its students join. */
    targets: z.array(z.object({ classId: idField, sectionId: idField }).strict()).max(20),
  })
  .strict()
  .refine((v) => new Set(v.targets.map((t) => t.classId)).size === v.targets.length, { message: "Choose one section per class.", path: ["targets"] });

export type ProposePromotionsInput = z.infer<typeof proposePromotionsSchema>;
export type ConfirmPromotionsInput = z.infer<typeof confirmPromotionsSchema>;
