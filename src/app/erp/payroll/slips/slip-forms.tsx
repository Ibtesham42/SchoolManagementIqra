"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { addAdjustmentAction, bulkPaymentAction, recordPaymentAction } from "../actions";

const METHODS = [
  { value: "BANK_TRANSFER", label: "Bank transfer" },
  { value: "UPI", label: "UPI" },
  { value: "CHEQUE", label: "Cheque" },
  { value: "CASH", label: "Cash" },
];

export function AddAdjustmentForm({ slipId }: { slipId: string }) {
  const [state, action] = useActionState(addAdjustmentAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="slipId" value={slipId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="adj-kind"
          label="Kind"
          name="kind"
          options={[
            { value: "BONUS", label: "Bonus (earning)" },
            { value: "ARREARS", label: "Arrears (earning)" },
            { value: "OTHER_EARNING", label: "Other earning" },
            { value: "OTHER_DEDUCTION", label: "Other deduction" },
          ]}
          error={state.fieldErrors?.kind}
        />
        <TextField id="adj-amount" label="Amount (₹)" name="amount" inputMode="decimal" required error={state.fieldErrors?.amount} />
      </div>
      <TextField id="adj-note" label="Note (shown on the slip)" name="note" maxLength={500} required hint="The employee sees this note on their slip — don't write internal remarks here." error={state.fieldErrors?.note} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Adding…">
        Add adjustment
      </SubmitButton>
    </form>
  );
}

export function RecordPaymentForm({ slipId, due, today }: { slipId: string; due: string; today: string }) {
  const [state, action] = useActionState(recordPaymentAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="slipId" value={slipId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="pay-amount" label="Amount (₹)" name="amount" inputMode="decimal" defaultValue={due} required error={state.fieldErrors?.amount} />
        <SelectField id="pay-method" label="Method" name="method" options={METHODS} error={state.fieldErrors?.method} />
        <TextField id="pay-ref" label="Reference (not needed for cash)" name="reference" maxLength={48} error={state.fieldErrors?.reference} />
        <TextField id="pay-date" label="Paid on" name="paidOn" type="date" defaultValue={today} max={today} required error={state.fieldErrors?.paidOn} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Record payment
      </SubmitButton>
    </form>
  );
}

/** Pay every remaining balance of the run at once; each slip's reference is "<batch>/<slip number>". */
export function BulkPaymentForm({ runId, today }: { runId: string; today: string }) {
  const [state, action] = useActionState(bulkPaymentAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="runId" value={runId} />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField id="bulk-method" label="Method" name="method" options={METHODS} error={state.fieldErrors?.method} />
        <TextField id="bulk-ref" label="Batch reference" name="reference" maxLength={48} error={state.fieldErrors?.reference} />
        <TextField id="bulk-date" label="Paid on" name="paidOn" type="date" defaultValue={today} max={today} required error={state.fieldErrors?.paidOn} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Recording…">
        Record full payment for all unpaid slips
      </SubmitButton>
    </form>
  );
}
