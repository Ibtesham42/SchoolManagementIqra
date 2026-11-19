import { z } from "zod";
import { idField, versionField } from "@/modules/students/person.schemas";
import { masterCodeSchema, masterNameSchema } from "@/modules/hr/hr.schemas";

/**
 * Phase 4A-M2 subjects (PHASE_4_PLAN.md AC2): school-defined; same code and Unicode-name rules as departments and
 * leave types (any script, NFC, single spaces) — the database CHECKs in migration 20261121000000 mirror them.
 */
export const SUBJECT_KINDS = ["SCHOLASTIC", "CO_SCHOLASTIC"] as const;
export const SUBJECT_KIND_LABEL: Record<(typeof SUBJECT_KINDS)[number], string> = {
  SCHOLASTIC: "Scholastic (marks count towards results)",
  CO_SCHOLASTIC: "Co-scholastic (activities, graded separately)",
};

const kind = z.enum(SUBJECT_KINDS, "Choose scholastic or co-scholastic.");

export const createSubjectSchema = z.object({ code: masterCodeSchema, name: masterNameSchema, kind }).strict();
export const updateSubjectSchema = z.object({ id: idField, version: versionField, code: masterCodeSchema, name: masterNameSchema, kind }).strict();
export const setSubjectActiveSchema = z.object({ id: idField, version: versionField, active: z.boolean() }).strict();

export type CreateSubjectInput = z.infer<typeof createSubjectSchema>;
export type UpdateSubjectInput = z.infer<typeof updateSubjectSchema>;
export type SetSubjectActiveInput = z.infer<typeof setSubjectActiveSchema>;
