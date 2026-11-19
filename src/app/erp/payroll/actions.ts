"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { createRunSchema, reopenRunSchema, runRefSchema } from "@/modules/payroll/runs.schemas";
import { approveRun, createRun, prepareRun, reopenRun } from "@/modules/payroll/runs.service";
import { decideSalarySchema, proposeSalarySchema, salaryRefSchema } from "@/modules/payroll/salaries.schemas";
import { decideSalary, proposeSalary, withdrawSalary } from "@/modules/payroll/salaries.service";
import { copyStructureSchema, createComponentSchema, createStructureSchema, setActiveSchema, updateComponentSchema, updateStructureSchema } from "@/modules/payroll/structures.schemas";
import { copyStructure, createComponent, createStructure, setComponentActive, setStructureActive, updateComponent, updateStructure } from "@/modules/payroll/structures.service";

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

// ───────────────────────────── 3C-M2 part 2: employee salaries ─────────────────────────────

export async function proposeSalaryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { employeeId: formString(fd, "employeeId"), structureId: formString(fd, "structureId"), basic: formString(fd, "basic"), effectiveFrom: formString(fd, "effectiveFrom") };
  return run(proposeSalarySchema, raw, async (ctx, d) => (await proposeSalary(ctx, d), "Salary proposed. It applies once a payroll approver approves it."));
}
export async function decideSalaryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { ...ref(fd), decision: formString(fd, "decision"), note: formString(fd, "note") };
  return run(decideSalarySchema, raw, async (ctx, d) => (await decideSalary(ctx, d), d.decision === "APPROVE" ? "Salary approved." : "Proposal rejected."));
}
export async function withdrawSalaryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(salaryRefSchema, ref(fd), async (ctx, d) => (await withdrawSalary(ctx, d), "Proposal withdrawn."));
}

export async function copyStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(copyStructureSchema, { id: formString(fd, "id"), name: formString(fd, "name") }, async (ctx, d) => `Copied as ${(await copyStructure(ctx, d))!.name}. Edit the copy, then propose new salaries.`);
}

// ───────────────────────────── 3C-M3: payroll runs ─────────────────────────────

export async function createRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createRunSchema, { month: formString(fd, "month") }, async (ctx, d) => (await createRun(ctx, d), `Payroll for ${d.month} created. Prepare it once attendance is complete.`));
}
export async function prepareRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(runRefSchema, ref(fd), async (ctx, d) => {
    const r = await prepareRun(ctx, d);
    const skipped = r.withoutSalary.length ? ` ${r.withoutSalary.length} staff have no approved salary and were left out: ${r.withoutSalary.slice(0, 5).map((e) => e.employeeCode).join(", ")}${r.withoutSalary.length > 5 ? ", …" : ""}.` : "";
    return `Prepared ${r.slips} slip(s).${skipped}`;
  });
}
export async function approveRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(runRefSchema, ref(fd), async (ctx, d) => `Payroll approved: ${(await approveRun(ctx, d)).slips} slip(s) numbered; the month's attendance is now locked.`);
}
export async function reopenRunAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(reopenRunSchema, { ...ref(fd), reason: formString(fd, "reason") }, async (ctx, d) => (await reopenRun(ctx, d), "Payroll reopened. Attendance for the month is unlocked; prepare it again before approving."));
}
