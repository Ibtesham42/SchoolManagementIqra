"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { clientIpHash } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import {
  checkResetToken,
  completePasswordReset,
  enforceResetRequestLimits,
  processResetRequest,
} from "@/modules/identity/password-reset.service";
import { passwordResetCompleteSchema, passwordResetRequestSchema } from "@/modules/identity/identity.schemas";
import { RateLimitedError } from "@/lib/errors";
import { RULES, hit } from "@/lib/rate-limit";
import { RESET_REQUESTED_MESSAGE } from "@/modules/identity/messages";

export async function requestResetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = passwordResetRequestSchema.safeParse({ identifier: formString(formData, "identifier") });
  if (!parsed.success) return { error: "Enter your username or email address." };
  const meta = { ipHash: await clientIpHash() };
  try {
    await enforceResetRequestLimits(parsed.data, meta);
  } catch (e) {
    if (e instanceof RateLimitedError) return { error: e.message };
    console.error("password reset request failed", e instanceof Error ? e.name : "unknown");
    return { ok: true, message: RESET_REQUESTED_MESSAGE };
  }
  // Lookup, token creation and email happen AFTER the response is sent, so an existing and a
  // non-existent account take the same time to answer (no timing-based enumeration).
  after(() =>
    processResetRequest(parsed.data, meta).catch((e) => {
      console.error("password reset processing failed", e instanceof Error ? e.name : "unknown");
    }),
  );
  return { ok: true, message: RESET_REQUESTED_MESSAGE };
}

/** Called by the reset page with the token read from the URL fragment (never from the query string). */
export async function checkResetTokenAction(token: string): Promise<{ valid: boolean }> {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return { valid: false };
  // Public endpoint: limit per client so it can't be used to keep the free-tier database awake.
  const limited = await hit(RULES.resetTokenCheck, await clientIpHash()).catch(() => ({ allowed: false }));
  if (!limited.allowed) return { valid: false };
  return { valid: await checkResetToken(token).catch(() => false) };
}

export async function completeResetAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = passwordResetCompleteSchema.safeParse({
    token: formString(formData, "token"),
    newPassword: formString(formData, "newPassword"),
    confirmPassword: formString(formData, "confirmPassword"),
  });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await completePasswordReset(parsed.data, { ipHash: await clientIpHash() });
  } catch (e) {
    return fromError(e);
  }
  redirect("/login?reset=1");
}
