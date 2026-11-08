"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginSchema, login } from "@/modules/identity/auth.service";
import { changeOwnPassword, changePasswordSchema } from "@/modules/identity/password.service";
import { clearSessionCookie, clientIpHash, requireAuth, setSessionCookie } from "@/lib/auth/context";
import { revokeSession, sessionCookieName } from "@/lib/auth/session";
import { formString, fromError, type ActionState } from "@/lib/action-state";

export async function loginAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    username: formString(formData, "username"),
    password: formString(formData, "password"),
    remember: formData.get("remember") === "on",
  });
  if (!parsed.success) return { error: "Enter your username and password." };

  let mustChange = false;
  try {
    const result = await login(parsed.data, {
      ipHash: await clientIpHash(),
      userAgent: (await headers()).get("user-agent") ?? undefined,
    });
    await setSessionCookie(result.token, result.expiresAt);
    mustChange = result.mustChangePassword;
  } catch (e) {
    return fromError(e);
  }
  redirect(mustChange ? "/erp/change-password" : "/erp");
}

export async function changePasswordAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const ctx = await requireAuth({ allowPendingPasswordChange: true });
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formString(formData, "currentPassword"),
    newPassword: formString(formData, "newPassword"),
    confirmPassword: formString(formData, "confirmPassword"),
  });
  if (!parsed.success) return { error: "Fill in all fields." };
  try {
    await changeOwnPassword(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  redirect("/erp");
}

export async function logoutAction() {
  const token = (await cookies()).get(sessionCookieName())?.value;
  if (token) await revokeSession(token).catch(() => undefined);
  await clearSessionCookie();
  redirect("/login");
}
