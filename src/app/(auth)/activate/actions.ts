"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientIpHash, setSessionCookie } from "@/lib/auth/context";
import { formString, fromError, type ActionState } from "@/lib/action-state";
import { activateAccountSchema } from "@/modules/identity/activation.schemas";
import { activateFamilyAccount } from "@/modules/students/family-accounts.service";

/** Phase 6A-M3 — the public activation form (ADR-046). On success: a fresh session, then the portal. */
export async function activateAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = activateAccountSchema.safeParse({
    username: formString(formData, "username"),
    code: formString(formData, "code"),
    dob: formString(formData, "dob"),
    consent: formData.get("consent") === "on",
    newPassword: formString(formData, "newPassword"),
    confirmPassword: formString(formData, "confirmPassword"),
  });
  if (!parsed.success) {
    const consentMissing = parsed.error.issues.some((i) => i.path[0] === "consent");
    return consentMissing ? { error: "Please read the privacy notice and tick the box to agree.", fieldErrors: { consent: "Required." } } : { error: "Fill in every field (the date of birth as on the school record)." };
  }
  try {
    const session = await activateFamilyAccount(parsed.data, { ipHash: await clientIpHash(), userAgent: (await headers()).get("user-agent") ?? undefined });
    await setSessionCookie(session.token, session.expiresAt);
  } catch (e) {
    return fromError(e);
  }
  redirect("/portal");
}
