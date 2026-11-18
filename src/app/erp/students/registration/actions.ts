"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { correctRollSchema, finalizeRollSchema, generateRollSchema } from "@/modules/students/roll-numbers.schemas";
import { correctRollNumber, finalizeRollNumbers, generateRollNumbers } from "@/modules/students/roll-numbers.service";

/** Roll-number actions: requireAuth → Zod → service (authorize, locks, audit) → refresh. */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, d: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    revalidatePath("/erp/students/registration", "layout");
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

export async function generateRollNumbersAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(generateRollSchema, { sectionId: formString(fd, "sectionId"), version: formString(fd, "version") }, async (ctx, d) => {
    const r = await generateRollNumbers(ctx, d.sectionId, d.version);
    return `Draft roll numbers generated for ${r.count} student${r.count === 1 ? "" : "s"}. Check them, then finalize.`;
  });
}

export async function finalizeRollNumbersAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(finalizeRollSchema, { sectionId: formString(fd, "sectionId"), version: formString(fd, "version"), confirm: formString(fd, "confirm") }, async (ctx, d) => {
    const r = await finalizeRollNumbers(ctx, d.sectionId, d.version, d.confirm);
    return `Roll numbers finalized for ${r.count} students. Students admitted later get the next number.`;
  });
}

export async function correctRollNumberAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { sectionId: formString(fd, "sectionId"), enrollmentId: formString(fd, "enrollmentId"), version: formString(fd, "version"), rollNumber: formString(fd, "rollNumber"), reason: formString(fd, "reason") };
  return run(correctRollSchema, raw, async (ctx, d) => (await correctRollNumber(ctx, d), `Roll number changed to ${d.rollNumber}.`));
}
