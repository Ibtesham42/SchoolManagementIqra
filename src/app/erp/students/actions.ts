"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { changeStatusSchema, updateGuardianSchema, updateStudentSchema } from "@/modules/students/students.schemas";
import { changeStudentStatus, updateGuardian, updateStudent } from "@/modules/students/students.service";

/**
 * Student-record actions: requireAuth → Zod → service (authorize, scope, field rules, locks, audit) →
 * refresh. Fields a form doesn't render (identity fields for a class teacher) are sent as undefined =
 * "unchanged"; the service still refuses any change outside the caller's allowance.
 */
type Outcome = { redirectTo: string } | { message: string };

async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, d: z.infer<S>) => Promise<Outcome>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  let outcome: Outcome;
  try {
    outcome = await call(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  revalidatePath("/erp/students", "layout");
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return { ok: true, message: outcome.message };
}

const optional = (fd: FormData, name: string) => (fd.has(name) ? formString(fd, name) : undefined);
const nothingChanged = "Nothing changed.";

export async function updateStudentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    id: formString(fd, "id"),
    version: formString(fd, "version"),
    firstName: optional(fd, "firstName"),
    middleName: optional(fd, "middleName"),
    lastName: optional(fd, "lastName"),
    dob: optional(fd, "dob"),
    gender: optional(fd, "gender"),
    phone: formString(fd, "phone"),
    email: formString(fd, "email"),
    address: {
      line1: formString(fd, "line1"),
      line2: formString(fd, "line2"),
      city: formString(fd, "city"),
      district: formString(fd, "district"),
      state: formString(fd, "state"),
      pinCode: formString(fd, "pinCode"),
      country: formString(fd, "country") || "India",
    },
  };
  return run(updateStudentSchema, raw, async (ctx, d) => {
    const r = await updateStudent(ctx, d);
    return r.changed.length ? { redirectTo: `/erp/students/${d.id}?saved=1` } : { message: nothingChanged };
  });
}

export async function updateGuardianAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    studentId: formString(fd, "studentId"),
    guardianId: formString(fd, "guardianId"),
    name: optional(fd, "name"),
    occupation: optional(fd, "occupation"),
    phone: formString(fd, "phone"),
    altPhone: formString(fd, "altPhone"),
    email: formString(fd, "email"),
  };
  return run(updateGuardianSchema, raw, async (ctx, d) => {
    const r = await updateGuardian(ctx, d);
    return { message: r.changed.length ? "Guardian details saved." : nothingChanged };
  });
}

export async function changeStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { id: formString(fd, "id"), version: formString(fd, "version"), toStatus: formString(fd, "toStatus"), effectiveDate: formString(fd, "effectiveDate"), reason: formString(fd, "reason") };
  return run(changeStatusSchema, raw, async (ctx, d) => (await changeStudentStatus(ctx, d), { redirectTo: `/erp/students/${d.id}?status=1` }));
}
