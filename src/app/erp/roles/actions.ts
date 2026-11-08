"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { ALL_PERMISSION_KEYS } from "@/lib/rbac/catalog";
import { createRoleSchema, setRolePermissionsSchema, updateRoleSchema } from "@/modules/identity/identity.schemas";
import { createRole, deleteRole, setRolePermissions, updateRole } from "@/modules/identity/roles.service";

export async function createRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = createRoleSchema.safeParse({ key: formString(fd, "key"), name: formString(fd, "name"), description: formString(fd, "description") });
  if (!parsed.success) return fromZod(parsed.error);
  let id: string;
  try {
    id = (await createRole(ctx, parsed.data)).id;
  } catch (e) {
    return fromError(e);
  }
  revalidatePath("/erp/roles");
  redirect(`/erp/roles/${id}`);
}

export async function updateRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = updateRoleSchema.safeParse({ id: formString(fd, "id"), name: formString(fd, "name"), description: formString(fd, "description") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await updateRole(ctx, parsed.data);
    revalidatePath(`/erp/roles/${parsed.data.id}`);
    return { ok: true, message: "Role details saved." };
  } catch (e) {
    return fromError(e);
  }
}

/** Form fields: perm.<key> = "" | ALL | ASSIGNED | SELF | CHILDREN */
export async function setRolePermissionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const grants = ALL_PERMISSION_KEYS.flatMap((key) => {
    const scope = formString(fd, `perm.${key}`);
    return scope ? [{ key, scope }] : [];
  });
  const parsed = setRolePermissionsSchema.safeParse({ id: formString(fd, "id"), grants });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await setRolePermissions(ctx, parsed.data);
    revalidatePath(`/erp/roles/${parsed.data.id}`);
    revalidatePath("/erp/roles");
    return { ok: true, message: `Saved ${parsed.data.grants.length} permission${parsed.data.grants.length === 1 ? "" : "s"}. Changes apply on each holder's next page load.` };
  } catch (e) {
    return fromError(e);
  }
}

export async function deleteRoleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    await deleteRole(ctx, formString(fd, "id"));
  } catch (e) {
    return fromError(e);
  }
  revalidatePath("/erp/roles");
  redirect("/erp/roles");
}
