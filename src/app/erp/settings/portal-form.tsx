"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updatePortalSettingsAction } from "./actions";

/** Phase 6C-M3 (P19, P17): the school's UPI ID for "Pay by UPI" in the parent portal, and the leaver window. */
export function PortalSettingsForm({ defaults }: { defaults: { payeeName: string; vpa: string; leaverAccessDays: number; studentAccounts: boolean; studentMinClassLevel: number } }) {
  const [state, action] = useActionState(updatePortalSettingsAction, initialState);
  // Controlled: React 19 resets uncontrolled fields after a form action, which would lose typed text on an error.
  const [payeeName, setPayeeName] = useState(defaults.payeeName);
  const [vpa, setVpa] = useState(defaults.vpa);
  const [days, setDays] = useState(String(defaults.leaverAccessDays));
  const [students, setStudents] = useState(defaults.studentAccounts);
  const [minLevel, setMinLevel] = useState(String(defaults.studentMinClassLevel));
  return (
    <form action={action} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="portal-payee" label="UPI payee name" name="payeeName" value={payeeName} onChange={(e) => setPayeeName(e.target.value)} maxLength={80} hint="As your bank shows it, e.g. the school's account name." error={state.fieldErrors?.payeeName} />
        <TextField id="portal-vpa" label="UPI ID" name="vpa" value={vpa} onChange={(e) => setVpa(e.target.value)} maxLength={320} inputMode="email" autoCapitalize="none" hint="e.g. school@bank. Leave both empty to turn UPI payments off." error={state.fieldErrors?.vpa} />
      </div>
      <TextField id="portal-leaver" label="Days a family keeps access after a child leaves" name="leaverAccessDays" type="number" min={0} max={365} value={days} onChange={(e) => setDays(e.target.value)} hint="Report cards and fees only. 0 = none." error={state.fieldErrors?.leaverAccessDays} />
      <label className="flex min-h-11 items-start gap-3 rounded-lg border p-3 text-sm has-checked:border-primary">
        <input type="checkbox" name="studentAccounts" checked={students} onChange={(e) => setStudents(e.target.checked)} className="mt-0.5 size-5 accent-primary" />
        <span>
          <span className="font-medium">Student accounts</span>
          <span className="block text-muted-foreground">Older students get their own sign-in (no fees). The office issues it only after a parent has activated their account; the slip goes to the parent. Turning this off switches off every student account at once, and raising &ldquo;From class&rdquo; switches off accounts below it; turning it back on revives none (reactivate them on Family access). A student account also stops when its last parent with portal access is switched off or blocked.</span>
        </span>
      </label>
      {students && (
        <TextField id="portal-min-level" label="From class" name="studentMinClassLevel" type="number" min={1} max={12} value={minLevel} onChange={(e) => setMinLevel(e.target.value)} hint="e.g. 9 = Class 9 and above." error={state.fieldErrors?.studentMinClassLevel} />
      )}
      {!students && <input type="hidden" name="studentMinClassLevel" value={minLevel} />}
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save portal settings
      </SubmitButton>
    </form>
  );
}
