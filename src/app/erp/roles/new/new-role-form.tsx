"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createRoleAction } from "../actions";

export function NewRoleForm() {
  const [state, action] = useActionState(createRoleAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <TextField label="Name" name="name" error={fe.name} required />
      <TextField
        label="Key"
        name="key"
        autoCapitalize="characters"
        spellCheck={false}
        hint="Permanent identifier, e.g. EXAM_COORDINATOR (capital letters, digits, underscores)."
        error={fe.key}
        required
      />
      <TextField label="Description (optional)" name="description" error={fe.description} />
      <SubmitButton className="w-full sm:w-auto">Create role</SubmitButton>
    </form>
  );
}
