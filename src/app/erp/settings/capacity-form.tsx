"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateDefaultCapacityAction } from "./actions";

/** School-wide default capacity for new sections (a default, not a limit). */
export function CapacityForm({ value }: { value: number }) {
  const [state, action] = useActionState(updateDefaultCapacityAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <div className="sm:w-60">
        <TextField
          label="Default section capacity"
          name="defaultSectionCapacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          defaultValue={value}
          hint="Offered for new sections when the class has no default of its own (1–200)."
          error={fe.defaultSectionCapacity}
          required
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">Save default capacity</SubmitButton>
    </form>
  );
}
