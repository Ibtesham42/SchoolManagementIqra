"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { approveRunAction, createRunAction, prepareRunAction, reopenRunAction } from "../actions";

export function CreateRunForm({ defaultMonth, max }: { defaultMonth: string; max: string }) {
  const [state, action] = useActionState(createRunAction, initialState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <TextField id="run-month" label="Month" name="month" type="month" defaultValue={defaultMonth} max={max} required error={state.fieldErrors?.month} />
      <SubmitButton className="min-h-11" pendingLabel="Creating…">
        Create payroll
      </SubmitButton>
      <div className="sm:col-span-2">
        <FormStatus state={state} />
      </div>
    </form>
  );
}

/** Prepare (or re-prepare) the run: computes every slip from approved salaries and the month's attendance. */
export function PrepareRunForm({ id, version, again }: { id: string; version: number; again: boolean }) {
  const [state, action] = useActionState(prepareRunAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Calculating…">
        {again ? "Prepare again" : "Prepare payroll"}
      </SubmitButton>
    </form>
  );
}

/** P6: the approver checks the totals and slips, then approves (slip numbers, attendance month locked). */
export function ApproveRunForm({ id, version }: { id: string; version: number }) {
  const [state, action] = useActionState(approveRunAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <p className="text-sm text-muted-foreground">Approving numbers the slips and locks this month&apos;s staff attendance. It is refused if anything changed since the payroll was prepared.</p>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Approving…">
        Approve payroll
      </SubmitButton>
    </form>
  );
}

/** P16: reopen before any payment, with a reason. */
export function ReopenRunForm({ id, version }: { id: string; version: number }) {
  const [state, action] = useActionState(reopenRunAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <TextField id={`reopen-${id}`} label="Why reopen?" name="reason" maxLength={300} required error={state.fieldErrors?.reason} />
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="min-h-11 w-full sm:w-auto" pendingLabel="Reopening…">
        Reopen payroll
      </SubmitButton>
    </form>
  );
}
