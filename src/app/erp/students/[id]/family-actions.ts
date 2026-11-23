"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { familyAccountActiveSchema, guardianInvitationSchema, portalAccessSchema } from "@/modules/students/family-accounts.schemas";
import { sendFamilyInvitation, setFamilyAccountActive, setGuardianPortalAccess } from "@/modules/students/family-accounts.service";
import { RULES, enforce } from "@/lib/rate-limit";

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

/** Phase 6A-M3b — email an activation link instead of printing a slip (same rate limit as slips). */
export async function sendInvitationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = guardianInvitationSchema.safeParse({ studentId: formString(fd, "studentId"), guardianId: formString(fd, "guardianId"), username: formString(fd, "username") });
  if (!parsed.success) return fromZod(parsed.error);
  let result: { sent: boolean; to: string };
  try {
    await enforce(RULES.portalSlips, ctx.userId);
    result = await sendFamilyInvitation(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  revalidatePath(`/erp/students/${parsed.data.studentId}`);
  return result.sent
    ? { ok: true, message: `Invitation sent to ${result.to}. The link works for 21 days; an earlier slip no longer works.` }
    : { error: "The email could not be sent. Print a slip instead (the emailed code was never delivered)." };
}
