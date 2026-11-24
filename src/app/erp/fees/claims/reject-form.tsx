"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { rejectClaimAction } from "./actions";

/** Reject with an office-only reason (the parent sees only "not confirmed"). */
export function RejectClaimForm({ id, version }: { id: string; version: number }) {
  const [state, action] = useActionState(rejectClaimAction, initialState);
  const [reason, setReason] = useState("");
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <TextField id={`reject-${id}`} label="Reason (office only)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} required hint="e.g. not on the bank statement, amount differs." error={state.fieldErrors?.reason} />
      <FormStatus state={state} />
      <SubmitButton variant="destructive" className="min-h-11 w-full sm:w-auto" pendingLabel="Rejecting…">
        Reject
      </SubmitButton>
    </form>
  );
}
