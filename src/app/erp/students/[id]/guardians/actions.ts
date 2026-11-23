"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { linkGuardianSchema, linkGuardianToStudent, mergeGuardians, mergeGuardiansSchema } from "@/modules/students/guardian-links.service";

/** Phase 6A-M3b — link an existing guardian to a student, or merge two records of the same parent. */
export async function linkGuardianAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = linkGuardianSchema.safeParse({ studentId: formString(fd, "studentId"), guardianId: formString(fd, "guardianId"), relation: formString(fd, "relation") });
  if (!parsed.success) return fromZod(parsed.error);
  let portalAccess: boolean;
  try {
    ({ portalAccess } = await linkGuardianToStudent(ctx, parsed.data));
  } catch (e) {
    return fromError(e);
  }
  revalidatePath(`/erp/students/${parsed.data.studentId}`, "layout");
  return portalAccess
    ? { ok: true, message: "Guardian linked. If they have a portal account, they see this student from their next page view." }
    : { ok: true, message: "Guardian linked with portal view BLOCKED, because another guardian of this student is blocked. Allow it on the student's Family access if that is right." };
}

export async function mergeGuardiansAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = mergeGuardiansSchema.safeParse({ studentId: formString(fd, "studentId"), keepGuardianId: formString(fd, "keepGuardianId"), removeGuardianId: formString(fd, "removeGuardianId"), confirmDifferent: formString(fd, "confirmDifferent") === "true" });
  if (!parsed.success) return fromZod(parsed.error);
  let moved: number;
  try {
    ({ movedLinks: moved } = await mergeGuardians(ctx, parsed.data));
  } catch (e) {
    return fromError(e);
  }
  revalidatePath(`/erp/students/${parsed.data.studentId}`, "layout");
  return { ok: true, message: `Records merged: ${moved} student link${moved === 1 ? "" : "s"} moved to the kept record.` };
}
