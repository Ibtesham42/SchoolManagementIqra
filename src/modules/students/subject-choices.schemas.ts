import { z } from "zod";
import { idField } from "./person.schemas";

/** Phase 4A-M2 optional subjects per student (PHASE_4_PLAN.md AC3). `.strict()`. */
export const sectionChoicesSchema = z.object({ sectionId: idField }).strict();

export const setSubjectChoicesSchema = z
  .object({
    sectionId: idField,
    classSubjectId: idField,
    /** Every student of the section who TAKES the subject after this save (the rest don't). */
    enrollmentIds: z.array(idField).max(200, "A section has at most 200 students."),
    /** The choices the screen showed when it loaded — a different current set means someone else saved (stale). */
    expectedIds: z.array(idField).max(200),
  })
  .strict()
  .refine((v) => new Set(v.enrollmentIds).size === v.enrollmentIds.length, { message: "Each student may appear only once.", path: ["enrollmentIds"] });

export type SectionChoicesInput = z.infer<typeof sectionChoicesSchema>;
export type SetSubjectChoicesInput = z.infer<typeof setSubjectChoicesSchema>;
