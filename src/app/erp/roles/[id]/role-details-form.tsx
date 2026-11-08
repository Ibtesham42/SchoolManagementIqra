"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateRoleAction } from "../actions";

export function RoleDetailsForm({ role }: { role: { id: string; name: string; description: string } }) {
  const [state, action] = useActionState(updateRoleAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={role.id} />
      <TextField label="Name" name="name" defaultValue={role.name} error={fe.name} required />
      <TextField label="Description" name="description" defaultValue={role.description} error={fe.description} />
      <SubmitButton variant="outline" className="w-full sm:w-auto">
        Save details
      </SubmitButton>
    </form>
  );
}
