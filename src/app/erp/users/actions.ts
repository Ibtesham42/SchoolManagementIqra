"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { createUserSchema, updateUserSchema, userIdSchema } from "@/modules/identity/identity.schemas";
import {
  adminResetPassword,
  createUser,
  revokeUserSessions,
  setUserActive,
  unlockUser,
  updateUser,
} from "@/modules/identity/users.service";

const roleKeysFrom = (fd: FormData) => fd.getAll("roleKeys").filter((v): v is string => typeof v === "string");

export async function createUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = createUserSchema.safeParse({
    username: formString(fd, "username"),
    displayName: formString(fd, "displayName"),
    email: formString(fd, "email"),
    roleKeys: roleKeysFrom(fd),
  });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const { user, temporaryPassword } = await createUser(ctx, parsed.data);
    revalidatePath("/erp/users");
    return { ok: true, message: `Account "${user.username}" created.`, secret: temporaryPassword };
  } catch (e) {
    return fromError(e);
  }
}

export async function updateUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = updateUserSchema.safeParse({
    id: formString(fd, "id"),
    displayName: formString(fd, "displayName"),
    email: formString(fd, "email"),
    roleKeys: roleKeysFrom(fd),
  });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await updateUser(ctx, parsed.data);
    revalidatePath(`/erp/users/${parsed.data.id}`);
    revalidatePath("/erp/users");
    return { ok: true, message: "Changes saved. New permissions apply on the user's next page load." };
  } catch (e) {
    return fromError(e);
  }
}

function idFrom(fd: FormData) {
  return userIdSchema.parse({ id: formString(fd, "id") }).id;
}

export async function deactivateUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    const id = idFrom(fd);
    await setUserActive(ctx, id, false);
    revalidatePath(`/erp/users/${id}`);
    return { ok: true, message: "Account deactivated and signed out everywhere." };
  } catch (e) {
    return fromError(e);
  }
}

export async function reactivateUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    const id = idFrom(fd);
    await setUserActive(ctx, id, true);
    revalidatePath(`/erp/users/${id}`);
    return { ok: true, message: "Account reactivated." };
  } catch (e) {
    return fromError(e);
  }
}

export async function resetUserPasswordAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    const id = idFrom(fd);
    const { temporaryPassword } = await adminResetPassword(ctx, id);
    revalidatePath(`/erp/users/${id}`);
    return { ok: true, message: "Password reset. All of this user's sessions were ended.", secret: temporaryPassword };
  } catch (e) {
    return fromError(e);
  }
}

export async function unlockUserAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    const id = idFrom(fd);
    await unlockUser(ctx, id);
    revalidatePath(`/erp/users/${id}`);
    return { ok: true, message: "Account unlocked." };
  } catch (e) {
    return fromError(e);
  }
}

export async function revokeSessionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  let self = false;
  try {
    const id = idFrom(fd);
    self = id === ctx.userId;
    const count = await revokeUserSessions(ctx, id);
    revalidatePath(`/erp/users/${id}`);
    if (!self) return { ok: true, message: `Signed out of ${count} session${count === 1 ? "" : "s"}.` };
  } catch (e) {
    return fromError(e);
  }
  redirect("/login"); // you signed yourself out everywhere, including this device
}
