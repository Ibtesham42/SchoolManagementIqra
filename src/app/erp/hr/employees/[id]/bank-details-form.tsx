"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateBankDetailsAction } from "../../actions";

const CHECK_ROW = "flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9";

/** P8: PAN and bank details. Saved values are never sent back to the browser — blank fields keep what is saved. */
export function BankDetailsForm({ employeeId, version, hasPan, hasBank }: { employeeId: string; version: number; hasPan: boolean; hasBank: boolean }) {
  const [state, action] = useActionState(updateBankDetailsAction, initialState);
  return (
    <form action={action} className="grid gap-3" autoComplete="off">
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="version" value={String(version)} />
      <TextField id="bd-pan" label="PAN" name="pan" maxLength={10} autoCapitalize="characters" placeholder={hasPan ? "Leave blank to keep the saved PAN" : "ABCDE1234F"} error={state.fieldErrors?.pan} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="bd-acc" label="Bank account number" name="bankAccount" inputMode="numeric" maxLength={20} placeholder={hasBank ? "Leave blank to keep it" : undefined} error={state.fieldErrors?.bankAccount} />
        <TextField id="bd-ifsc" label="IFSC" name="bankIfsc" maxLength={11} autoCapitalize="characters" error={state.fieldErrors?.bankIfsc} />
      </div>
      <TextField id="bd-name" label="Name on the account" name="bankAccountName" maxLength={120} hint="A new account number needs its IFSC and account name too." error={state.fieldErrors?.bankAccountName} />
      {hasPan && (
        <label className={CHECK_ROW}>
          <input type="checkbox" name="removePan" className="size-5 accent-primary" />
          Remove the saved PAN
        </label>
      )}
      {hasBank && (
        <label className={CHECK_ROW}>
          <input type="checkbox" name="removeBank" className="size-5 accent-primary" />
          Remove the saved bank details
        </label>
      )}
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save PAN / bank details
      </SubmitButton>
    </form>
  );
}
