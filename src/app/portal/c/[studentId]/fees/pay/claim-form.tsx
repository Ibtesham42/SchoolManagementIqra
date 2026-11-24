"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { submitClaimAction } from "./actions";

const METHODS = [
  ["UPI", "UPI app (Google Pay, PhonePe, Paytm, BHIM…)"],
  ["BANK_TRANSFER", "Bank transfer (NEFT / IMPS / RTGS)"],
] as const;

/** Phase 6C-M3 — "I have paid": how, the amount, the reference from the UPI / bank app, and the date. */
export function ClaimForm({ studentId, due, today, earliest }: { studentId: string; due: string; today: string; earliest: string }) {
  const [state, action] = useActionState(submitClaimAction, initialState);
  // Controlled: React 19 resets uncontrolled fields after a form action, which would lose typed text on an error.
  const [amount, setAmount] = useState(due);
  const [method, setMethod] = useState<"UPI" | "BANK_TRANSFER">("UPI");
  const [ref, setRef] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="studentId" value={studentId} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">How did you pay?</legend>
        {METHODS.map(([v, label]) => (
          <label key={v} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary">
            <input type="radio" name="method" value={v} checked={method === v} onChange={() => setMethod(v)} className="size-5 accent-primary" />
            {label}
          </label>
        ))}
      </fieldset>
      <TextField id="claim-amount" label="Amount paid (Rs.)" name="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required error={state.fieldErrors?.amount} hint={`Due today: Rs. ${due}`} />
      <TextField
        id="claim-ref"
        label={method === "UPI" ? "UPI transaction reference (UTR, 12 digits)" : "Bank transaction reference"}
        name="transactionRef"
        value={ref}
        onChange={(e) => setRef(e.target.value)}
        maxLength={60}
        autoComplete="off"
        inputMode={method === "UPI" ? "numeric" : "text"}
        required
        hint={method === "UPI" ? "In your UPI app, open the payment and copy the UTR / UPI Ref. No." : "As shown in your bank's confirmation."}
        error={state.fieldErrors?.transactionRef}
      />
      <TextField id="claim-date" label="Paid on" name="paidOn" type="date" min={earliest} max={today} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required error={state.fieldErrors?.paidOn} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Sending…">
        Send to the school
      </SubmitButton>
    </form>
  );
}
