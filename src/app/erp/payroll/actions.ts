"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { createComponentSchema, createStructureSchema, setActiveSchema, updateComponentSchema, updateStructureSchema } from "@/modules/payroll/structures.schemas";
import { createComponent, createStructure, setComponentActive, setStructureActive, updateComponent, updateStructure } from "@/modules/payroll/structures.service";

/** Phase 3C payroll actions: requireAuth → Zod → service → ActionState (services authorize and enforce every rule). */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    revalidatePath("/erp/payroll", "layout");
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });
const componentFields = (fd: FormData) => ({
  code: formString(fd, "code"),
  name: formString(fd, "name"),
  kind: formString(fd, "kind"),
  calc: formString(fd, "calc"),
  prorated: formString(fd, "prorated"),
});
const structureFields = (fd: FormData) => {
  const components = fd.getAll("componentId").slice(0, 31);
  const values = fd.getAll("value");
  return {
    name: formString(fd, "name"),
    items: components
      .map((c, i) => ({ componentId: typeof c === "string" ? c : "", value: typeof values[i] === "string" ? (values[i] as string) : "" }))
      .filter((i) => i.componentId !== ""),
  };
};

export async function createComponentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createComponentSchema, componentFields(fd), async (ctx, d) => `Component ${(await createComponent(ctx, d))!.name} added.`);
}
export async function updateComponentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateComponentSchema, { ...ref(fd), ...componentFields(fd) }, async (ctx, d) => (await updateComponent(ctx, d), "Component saved."));
}
export async function setComponentActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => (await setComponentActive(ctx, d), d.active ? "Component activated." : "Component deactivated."));
}
export async function createStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createStructureSchema, structureFields(fd), async (ctx, d) => `Structure ${(await createStructure(ctx, d))!.name} added.`);
}
export async function updateStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateStructureSchema, { ...ref(fd), ...structureFields(fd) }, async (ctx, d) => (await updateStructure(ctx, d), "Structure saved. Slips already prepared keep their old values."));
}
export async function setStructureActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => (await setStructureActive(ctx, d), d.active ? "Structure activated." : "Structure deactivated."));
}
