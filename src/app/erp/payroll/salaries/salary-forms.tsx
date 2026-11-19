"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { decideSalaryAction, proposeSalaryAction } from "../actions";

/** HR proposes basic + structure from a month (P7). It applies only after a payroll approver approves it. */
export function ProposeSalaryForm({ employeeId, structures, defaultMonth }: { employeeId: string; structures: { value: string; label: string }[]; defaultMonth: string }) {
  const [state, action] = useActionState(proposeSalaryAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="employeeId" value={employeeId} />
      <SelectField id="ps-structure" label="Salary structure" name="structureId" options={[{ value: "", label: "Choose…" }, ...structures]} required error={state.fieldErrors?.structureId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="ps-basic" label="Monthly basic (₹)" name="basic" inputMode="decimal" required placeholder="e.g. 25000" error={state.fieldErrors?.basic} />
        <TextField id="ps-month" label="Applies from (month)" name="effectiveFrom" type="month" defaultValue={defaultMonth} required error={state.fieldErrors?.effectiveFrom} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Sending…">
        Propose salary
      </SubmitButton>
    </form>
  );
}

/** A payroll approver approves or rejects (reason required) a pending proposal of someone else. */
export function DecideSalaryForm({ id, version, idPrefix }: { id: string; version: number; idPrefix: string }) {
  const [state, action] = useActionState(decideSalaryAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <div className="grid gap-1.5">
        <label htmlFor={`${idPrefix}-${id}-note`} className="text-sm font-medium">
          Note (required to reject)
        </label>
        <textarea id={`${idPrefix}-${id}-note`} name="note" rows={2} maxLength={500} className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" />
        {state.fieldErrors?.note && <p className="text-sm text-destructive">{state.fieldErrors.note}</p>}
      </div>
      <FormStatus state={state} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton name="decision" value="APPROVE" className="min-h-11" pendingLabel="Saving…">
          Approve
        </SubmitButton>
        <SubmitButton name="decision" value="REJECT" variant="outline" className="min-h-11" pendingLabel="Saving…">
          Reject
        </SubmitButton>
      </div>
    </form>
  );
}
