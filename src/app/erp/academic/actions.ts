"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  assignClassTeacherSchema,
  copySectionsSchema,
  createClassSchema,
  createSectionsBulkSchema,
  recordRefSchema,
  setActiveSchema,
  splitSectionNames,
  updateClassSchema,
  updateSectionSchema,
} from "@/modules/academic/academic.schemas";
import { createClass, setClassActive, updateClass } from "@/modules/academic/classes.service";
import { createSubjectSchema, setSubjectActiveSchema, updateSubjectSchema } from "@/modules/academic/subjects.schemas";
import { createSubject, setSubjectActive, updateSubject } from "@/modules/academic/subjects.service";
import {
  assignClassTeacher,
  copySectionsFromSession,
  createSectionsBulk,
  deleteSection,
  setSectionActive,
  unassignClassTeacher,
  updateSection,
} from "@/modules/academic/sections.service";

const refresh = () => revalidatePath("/erp/academic", "layout");

/** requireAuth → Zod parse → service → refresh; every error becomes a safe ActionState. */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    refresh();
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

const classFields = (fd: FormData) => ({
  code: formString(fd, "code"),
  name: formString(fd, "name"),
  numericLevel: formString(fd, "numericLevel"),
  displayOrder: formString(fd, "displayOrder"),
  defaultSectionCapacity: formString(fd, "defaultSectionCapacity"),
});
const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });

export async function createClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createClassSchema, classFields(fd), async (ctx, d) => `Class ${(await createClass(ctx, d)).name} created.`);
}

export async function updateClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateClassSchema, { ...ref(fd), ...classFields(fd) }, async (ctx, d) => (await updateClass(ctx, d), "Class saved."));
}

export async function setClassActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setClassActive(ctx, d.id, d.version, d.active);
    return d.active ? "Class activated." : "Class deactivated. It gets no new sections; existing sections are unchanged.";
  });
}

export async function createSectionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { academicSessionId: formString(fd, "academicSessionId"), classId: formString(fd, "classId"), names: splitSectionNames(formString(fd, "names")), capacity: formString(fd, "capacity") };
  return run(createSectionsBulkSchema, raw, async (ctx, d) => {
    const created = await createSectionsBulk(ctx, d);
    return created.length === 1 ? `Section ${created[0].name} created.` : `${created.length} sections created: ${created.map((s) => s.name).join(", ")}.`;
  });
}

export async function updateSectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateSectionSchema, { ...ref(fd), name: formString(fd, "name"), capacity: formString(fd, "capacity") }, async (ctx, d) => (await updateSection(ctx, d), "Section saved."));
}

export async function setSectionActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setSectionActive(ctx, d.id, d.version, d.active);
    return d.active ? "Section activated." : "Section deactivated. It accepts no new enrolments.";
  });
}

export async function deleteSectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await deleteSection(ctx, d.id, d.version), "Section deleted."));
}

export async function assignClassTeacherAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(assignClassTeacherSchema, { ...ref(fd), userId: formString(fd, "userId") }, async (ctx, d) => (await assignClassTeacher(ctx, d), "Class teacher assigned."));
}

export async function unassignClassTeacherAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await unassignClassTeacher(ctx, d.id, d.version), "Class teacher removed."));
}

export async function copySectionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(copySectionsSchema, { fromSessionId: formString(fd, "fromSessionId"), toSessionId: formString(fd, "toSessionId") }, async (ctx, d) => {
    const r = await copySectionsFromSession(ctx, d);
    return `${r.created} section${r.created === 1 ? "" : "s"} copied${r.skipped ? `, ${r.skipped} already existed` : ""}. Class teachers were not copied.`;
  });
}

// ───────────────────────────── Phase 4A-M2: subjects ─────────────────────────────

const subjectFields = (fd: FormData) => ({ code: formString(fd, "code"), name: formString(fd, "name"), kind: formString(fd, "kind") });

export async function createSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createSubjectSchema, subjectFields(fd), async (ctx, d) => `Subject ${(await createSubject(ctx, d))!.name} added.`);
}

export async function updateSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateSubjectSchema, { ...ref(fd), ...subjectFields(fd) }, async (ctx, d) => (await updateSubject(ctx, d), "Subject saved."));
}

export async function setSubjectActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setSubjectActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setSubjectActive(ctx, d);
    return d.active ? "Subject activated." : "Subject deactivated. It can't be added to classes; existing classes keep it.";
  });
}
