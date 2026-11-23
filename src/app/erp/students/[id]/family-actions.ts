"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { familyAccountActiveSchema, portalAccessSchema } from "@/modules/students/family-accounts.schemas";
import { setFamilyAccountActive, setGuardianPortalAccess } from "@/modules/students/family-accounts.service";

/** Phase 6A-M3 — "Family access" actions on the student profile (slips themselves are POSTed to the PDF route). */
export async function setPortalAccessAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = portalAccessSchema.safeParse({ studentId: formString(fd, "studentId"), guardianId: formString(fd, "guardianId"), portalAccess: formString(fd, "portalAccess") === "true" });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await setGuardianPortalAccess(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  revalidatePath(`/erp/students/${parsed.data.studentId}`);
  return { ok: true, message: parsed.data.portalAccess ? "This guardian can see this student in the portal again." : "This guardian no longer sees this student in the portal." };
}

export async function setFamilyAccountActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = familyAccountActiveSchema.safeParse({ studentId: formString(fd, "studentId"), guardianId: formString(fd, "guardianId"), active: formString(fd, "active") === "true", reason: formString(fd, "reason") });
  if (!parsed.success) return fromZod(parsed.error);
  let changed: boolean;
  try {
    changed = await setFamilyAccountActive(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  revalidatePath(`/erp/students/${parsed.data.studentId}`);
  if (!changed) return { ok: true, message: "Nothing changed." };
  return { ok: true, message: parsed.data.active ? "Account reactivated. Print a new slip if the parent no longer has a password." : "Account deactivated and signed out everywhere." };
}
