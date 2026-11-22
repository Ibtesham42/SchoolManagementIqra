"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { cancelReceiptAction, findReceiptAction } from "./actions";

/** Find a receipt by its exact number — POSTed, then redirected to the receipt page. */
export function ReceiptLookup() {
  const [state, action] = useActionState(findReceiptAction, initialState);
  const [receiptNo, setReceiptNo] = useState("");
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <TextField id="receipt-no" label="Receipt number" name="receiptNo" value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} minLength={2} maxLength={40} required autoComplete="off" error={state.fieldErrors?.receiptNo} />
      <SubmitButton className="min-h-11" pendingLabel="Finding…">
        Find
      </SubmitButton>
      {state.error && (
        <div className="sm:col-span-2">
          <FormStatus state={state} />
        </div>
      )}
    </form>
  );
}

/** Cancel a receipt (FC13): reason required; the money must be handed back or the cheque returned outside the system. */
export function CancelReceiptForm({ id, version, receiptNo }: { id: string; version: number; receiptNo: string }) {
  const [state, action] = useActionState(cancelReceiptAction, initialState);
  const [reason, setReason] = useState("");
  if (state.ok) return <FormStatus state={state} />;
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <label htmlFor={`cancel-receipt-${id}`} className="text-sm font-medium">
        Why is receipt {receiptNo} cancelled?
      </label>
      <textarea
        id={`cancel-receipt-${id}`}
        name="reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        required
        minLength={5}
        maxLength={500}
        rows={3}
        aria-describedby={`cancel-receipt-${id}-hint`}
        aria-invalid={state.fieldErrors?.reason ? true : undefined}
        className="min-h-24 rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm"
      />
      <p id={`cancel-receipt-${id}-hint`} className="text-sm text-muted-foreground">
        For example: cheque bounced, wrong student, entered twice. The receipt keeps its number and is marked cancelled; the amount becomes due again.
      </p>
      {state.fieldErrors?.reason && <p className="text-sm text-destructive">{state.fieldErrors.reason}</p>}
      <FormStatus state={state} />
      <SubmitButton variant="destructive" className="min-h-11 w-full sm:w-auto" pendingLabel="Cancelling…">
        Cancel receipt
      </SubmitButton>
    </form>
  );
}
