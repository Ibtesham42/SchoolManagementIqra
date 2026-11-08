"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateUserAction } from "../actions";
import { RoleCheckboxes, type RoleOption } from "../role-checkboxes";

export function EditUserForm({
  user,
  roles,
}: {
  user: { id: string; displayName: string; email: string; roleKeys: string[] };
  roles: RoleOption[];
}) {
  const [state, action] = useActionState(updateUserAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={user.id} />
      {/* A disabled checkbox doesn't submit; keep locked-in roles (e.g. own Super Admin) in the payload. */}
      {roles
        .filter((r) => r.disabled && user.roleKeys.includes(r.key))
        .map((r) => (
          <input key={r.key} type="hidden" name="roleKeys" value={r.key} />
        ))}
      <TextField label="Full name" name="displayName" defaultValue={user.displayName} error={fe.displayName} required />
      <TextField label="Email (optional)" name="email" type="email" defaultValue={user.email} error={fe.email} />
      <RoleCheckboxes roles={roles} selected={user.roleKeys} error={fe.roleKeys} />
      <SubmitButton className="w-full sm:w-auto">Save changes</SubmitButton>
    </form>
  );
}
