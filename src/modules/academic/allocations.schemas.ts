import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";

/** Phase 4A-M2 teacher allocation (PHASE_4_PLAN.md AC4). `.strict()`; the service re-checks everything under locks. */
export const sectionAllocationsSchema = z.object({ sectionId: idField }).strict();

export const assignTeacherSchema = z
  .object({
    sectionId: idField,
    classSubjectId: idField,
    employeeId: idField,
    /** Version of the current allocation, or null when the subject has no teacher yet in this section. */
    version: versionField.nullable(),
  })
  .strict();

export const allocationRefSchema = z.object({ id: idField, version: versionField }).strict();

export type SectionAllocationsInput = z.infer<typeof sectionAllocationsSchema>;
export type AssignTeacherInput = z.infer<typeof assignTeacherSchema>;
export type AllocationRefInput = z.infer<typeof allocationRefSchema>;
