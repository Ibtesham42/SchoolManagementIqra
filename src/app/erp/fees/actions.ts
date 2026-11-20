"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  clearLateFeeRuleSchema,
  copyStructureSchema,
  createCategorySchema,
  createInstallmentSchema,
  createStructureSchema,
  feeNumberFormatsSchema,
  refSchema,
  setActiveSchema,
  setLateFeeRuleSchema,
  updateCategorySchema,
  updateInstallmentSchema,
  updateStructureSchema,
} from "@/modules/fees/setup.schemas";
import {
  clearLateFeeRule,
  copyFeeStructure,
  createFeeCategory,
  createFeeInstallment,
  createFeeStructure,
  deleteFeeInstallment,
  setFeeCategoryActive,
  setFeeStructureActive,
  setLateFeeRule,
  updateFeeCategory,
  updateFeeInstallment,
  updateFeeStructure,
} from "@/modules/fees/setup.service";
import { updateFeeNumberFormats } from "@/modules/settings/settings.service";
import { cancelInvoiceSchema, generateInvoicesSchema } from "@/modules/fees/invoices.schemas";
import { cancelInvoice, issueInvoices } from "@/modules/fees/invoices.service";
import { addChargeSchema, concessionRefSchema, createConcessionSchema, decideConcessionSchema, proposeConcessionSchema, updateConcessionSchema } from "@/modules/fees/concessions.schemas";
import { addCharge, createConcession, decideConcession, proposeConcession, removeCharge, revokeConcession, setConcessionActive, updateConcession } from "@/modules/fees/concessions.service";

/** Phase 5A-M2 fee setup actions: requireAuth → Zod → service → ActionState (services authorize and enforce every rule). */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    revalidatePath("/erp/fees", "layout");
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });
const active = (fd: FormData) => ({ ...ref(fd), active: formString(fd, "active") === "true" });
const items = (fd: FormData) => {
  const cats = fd.getAll("categoryId").slice(0, 401);
  const insts = fd.getAll("installmentId");
  const amounts = fd.getAll("amount");
  return cats
    .map((c, i) => ({ categoryId: typeof c === "string" ? c : "", installmentId: typeof insts[i] === "string" ? (insts[i] as string) : "", amount: typeof amounts[i] === "string" ? (amounts[i] as string) : "" }))
    .filter((i) => i.categoryId !== "" || i.installmentId !== "" || i.amount !== "");
};

// Fee heads
export async function createCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { code: formString(fd, "code"), name: formString(fd, "name"), kind: formString(fd, "kind"), appliesTo: formString(fd, "appliesTo") };
  return run(createCategorySchema, raw, async (ctx, d) => (await createFeeCategory(ctx, d), "Fee head added."));
}
export async function updateCategoryAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateCategorySchema, { ...ref(fd), name: formString(fd, "name"), appliesTo: formString(fd, "appliesTo") }, async (ctx, d) => (await updateFeeCategory(ctx, d), "Fee head saved."));
}
export async function setCategoryActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, active(fd), async (ctx, d) => (await setFeeCategoryActive(ctx, d), d.active ? "Fee head activated." : "Fee head deactivated."));
}

// Number formats
export async function updateFeeNumberFormatsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(feeNumberFormatsSchema, { feeReceipt: formString(fd, "feeReceipt"), feeInvoice: formString(fd, "feeInvoice") }, async (ctx, d) => (await updateFeeNumberFormats(ctx, d), "Number formats saved."));
}

// Installments
export async function createInstallmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { academicSessionId: formString(fd, "academicSessionId"), name: formString(fd, "name"), dueOn: formString(fd, "dueOn"), sortOrder: formString(fd, "sortOrder") || "0" };
  return run(createInstallmentSchema, raw, async (ctx, d) => (await createFeeInstallment(ctx, d), "Installment added."));
}
export async function updateInstallmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { ...ref(fd), name: formString(fd, "name"), dueOn: formString(fd, "dueOn"), sortOrder: formString(fd, "sortOrder") || "0" };
  return run(updateInstallmentSchema, raw, async (ctx, d) => (await updateFeeInstallment(ctx, d), "Installment saved."));
}
export async function deleteInstallmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(refSchema, ref(fd), async (ctx, d) => (await deleteFeeInstallment(ctx, d), "Installment deleted."));
}

// Late fee
export async function setLateFeeRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const cap = formString(fd, "cap").trim();
  const raw = { academicSessionId: formString(fd, "academicSessionId"), graceDays: formString(fd, "graceDays"), calc: formString(fd, "calc"), value: formString(fd, "value"), cap: cap === "" ? null : cap };
  return run(setLateFeeRuleSchema, raw, async (ctx, d) => (await setLateFeeRule(ctx, d), "Late fee rule saved."));
}
export async function clearLateFeeRuleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(clearLateFeeRuleSchema, { academicSessionId: formString(fd, "academicSessionId") }, async (ctx, d) => (await clearLateFeeRule(ctx, d.academicSessionId), "Late fee turned off."));
}

// Structures
export async function createStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { academicSessionId: formString(fd, "academicSessionId"), classId: formString(fd, "classId"), name: formString(fd, "name"), items: items(fd) };
  return run(createStructureSchema, raw, async (ctx, d) => {
    const st = await createFeeStructure(ctx, d);
    return st?.isActive ? "Fee structure added and active." : "Fee structure added (inactive: the class already has an active one).";
  });
}
export async function updateStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateStructureSchema, { ...ref(fd), name: formString(fd, "name"), items: items(fd) }, async (ctx, d) => (await updateFeeStructure(ctx, d), "Fee structure saved."));
}
export async function copyStructureAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(copyStructureSchema, { id: formString(fd, "id"), name: formString(fd, "name") }, async (ctx, d) => (await copyFeeStructure(ctx, d), "Copy created (inactive)."));
}
export async function setStructureActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, active(fd), async (ctx, d) => (await setFeeStructureActive(ctx, d), d.active ? "Structure is now active for new invoices." : "Structure deactivated."));
}

// ───────────────────────────── Phase 5A-M3: concessions and charges ─────────────────────────────

const ids = (fd: FormData, name: string) => fd.getAll(name).filter((v): v is string => typeof v === "string" && v !== "").slice(0, 51);

export async function createConcessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { code: formString(fd, "code"), name: formString(fd, "name"), kind: formString(fd, "kind"), calc: formString(fd, "calc"), value: formString(fd, "value"), categoryIds: ids(fd, "categoryId") };
  return run(createConcessionSchema, raw, async (ctx, d) => (await createConcession(ctx, d), "Concession added."));
}
export async function updateConcessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { ...ref(fd), name: formString(fd, "name"), kind: formString(fd, "kind"), calc: formString(fd, "calc"), value: formString(fd, "value"), categoryIds: ids(fd, "categoryId") };
  return run(updateConcessionSchema, raw, async (ctx, d) => (await updateConcession(ctx, d), "Concession saved."));
}
export async function setConcessionActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, active(fd), async (ctx, d) => (await setConcessionActive(ctx, d), d.active ? "Concession activated." : "Concession deactivated."));
}
export async function proposeConcessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { studentId: formString(fd, "studentId"), academicSessionId: formString(fd, "academicSessionId"), concessionId: formString(fd, "concessionId"), reason: formString(fd, "reason") };
  return run(proposeConcessionSchema, raw, async (ctx, d) => (await proposeConcession(ctx, d), "Proposed. Another person with approval rights must now approve it."));
}
export async function decideConcessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(decideConcessionSchema, { ...ref(fd), decision: formString(fd, "decision") }, async (ctx, d) => (await decideConcession(ctx, d), d.decision === "APPROVE" ? "Concession approved." : "Concession rejected."));
}
export async function revokeConcessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(concessionRefSchema, ref(fd), async (ctx, d) => (await revokeConcession(ctx, d), "Concession revoked for future invoices."));
}
export async function addChargeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    studentId: formString(fd, "studentId"),
    academicSessionId: formString(fd, "academicSessionId"),
    installmentId: formString(fd, "installmentId"),
    categoryId: formString(fd, "categoryId"),
    amount: formString(fd, "amount"),
    note: formString(fd, "note"),
  };
  return run(addChargeSchema, raw, async (ctx, d) => (await addCharge(ctx, d), "Charge added. It goes on the student's invoice for that installment."));
}
export async function removeChargeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(concessionRefSchema, ref(fd), async (ctx, d) => (await removeCharge(ctx, d), "Charge removed."));
}

// ───────────────────────────── Phase 5A-M4: invoices ─────────────────────────────

export async function issueInvoicesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { academicSessionId: formString(fd, "academicSessionId"), classId: formString(fd, "classId"), installmentId: formString(fd, "installmentId") };
  const countRaw = formString(fd, "expectedCount");
  const count = Number(countRaw);
  const expected = /^\d{1,5}$/.test(countRaw) && Number.isInteger(count) ? { count, total: formString(fd, "expectedTotal"), structureId: formString(fd, "expectedStructure") } : undefined;
  return run(generateInvoicesSchema, raw, async (ctx, d) => {
    const r = await issueInvoices(ctx, d, expected);
    return !r || r.issued === 0 ? "Nothing to issue: everyone billable already has this invoice." : `${r.issued} invoice${r.issued === 1 ? "" : "s"} issued.`;
  });
}
export async function cancelInvoiceAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(cancelInvoiceSchema, { ...ref(fd), reason: formString(fd, "reason") }, async (ctx, d) => (await cancelInvoice(ctx, d), "Invoice cancelled. It can be issued again."));
}
