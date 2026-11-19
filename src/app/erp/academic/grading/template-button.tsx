"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createCbseStyleScaleAction } from "../actions";

/** AC8: the CBSE-style 8-point scale is created only when the school asks for it, as an ordinary editable scale. */
export function TemplateButton() {
  const [state, action] = useActionState(createCbseStyleScaleAction, initialState);
  return (
    <form action={action} className="grid gap-2">
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="min-h-11 w-full sm:w-auto" pendingLabel="Creating…">
        Start from the CBSE-style 8-point template
      </SubmitButton>
    </form>
  );
}
