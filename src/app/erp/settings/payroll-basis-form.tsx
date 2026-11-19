"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updatePayrollDayBasisAction } from "./actions";

const OPTIONS = [
  { value: "WORKING_DAYS", label: "Working days", hint: "Pay ÷ the month's working days (weekly offs and staff holidays excluded)." },
  { value: "CALENDAR_DAYS", label: "Calendar days", hint: "Pay ÷ every day of the month (28–31)." },
] as const;

/** P3: no default — payroll runs refuse to prepare until the school chooses. */
export function PayrollBasisForm({ current }: { current: string | null }) {
  const [state, action] = useActionState(updatePayrollDayBasisAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <fieldset className="grid gap-2">
        <legend className="sr-only">Payroll proration basis</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm has-checked:border-primary">
            <input type="radio" name="payrollDayBasis" value={o.value} defaultChecked={current === o.value} className="mt-0.5 size-5 accent-primary" />
            <span>
              <span className="font-medium">{o.label}</span>
              <span className="block text-muted-foreground">{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save payroll basis
      </SubmitButton>
    </form>
  );
}
