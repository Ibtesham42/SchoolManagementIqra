"use client";

import { useActionState, useState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { addChargeAction, createConcessionAction, proposeConcessionAction, updateConcessionAction } from "./actions";

const KINDS = [
  { value: "CONCESSION", label: "Concession" },
  { value: "SCHOLARSHIP", label: "Scholarship" },
  { value: "DISCOUNT", label: "Discount" },
  { value: "WAIVER", label: "Waiver" },
];
const CHECK_ROW = "flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9";

/** A concession template: a percentage, or a fixed amount PER INSTALLMENT invoice (KI-102), on chosen fee heads. */
export function ConcessionForm({
  defaults,
  heads,
}: {
  defaults: { id?: string; version?: number; code: string; name: string; kind: string; calc: string; value: string; categoryIds: string[]; locked?: boolean };
  heads: { id: string; name: string }[];
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateConcessionAction : createConcessionAction, initialState);
  const [calc, setCalc] = useState(defaults.calc || "PERCENT");
  const id = (f: string) => `cn-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField id={id("name")} label="Name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Sibling concession, Merit scholarship"} error={state.fieldErrors?.name} />
      <div className="grid gap-3 sm:grid-cols-2">
        {!editing && <TextField id={id("code")} label="Code" name="code" defaultValue={defaults.code} maxLength={20} required placeholder="e.g. SIBLING" error={state.fieldErrors?.code} />}
        <SelectField id={id("kind")} label="Type" name="kind" defaultValue={defaults.kind || "CONCESSION"} options={KINDS} error={state.fieldErrors?.kind} />
        <SelectField
          id={id("calc")}
          label="Given as"
          name="calc"
          value={calc}
          disabled={defaults.locked}
          onChange={(e) => setCalc(e.target.value)}
          options={[
            { value: "PERCENT", label: "A percentage of the fee" },
            { value: "FIXED", label: "A fixed amount on every installment (₹)" },
          ]}
          error={state.fieldErrors?.calc}
        />
        {defaults.locked && <input type="hidden" name="calc" value={calc} />}
        <TextField
          id={id("value")}
          label={calc === "PERCENT" ? "Percentage" : "Amount per installment (₹)"}
          name="value"
          inputMode="decimal"
          defaultValue={defaults.value}
          readOnly={defaults.locked}
          required
          hint={calc === "FIXED" ? "Taken off EVERY installment invoice: with 12 monthly installments, 500 means 6,000 a year." : undefined}
          error={state.fieldErrors?.value}
        />
      </div>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">On these fee heads</legend>
        {heads.map((h) => (
          <label key={h.id} className={CHECK_ROW}>
            {defaults.locked ? (
              <>
                <input type="checkbox" checked={defaults.categoryIds.includes(h.id)} disabled className="size-5 accent-primary" />
                {defaults.categoryIds.includes(h.id) && <input type="hidden" name="categoryId" value={h.id} />}
              </>
            ) : (
              <input type="checkbox" name="categoryId" value={h.id} defaultChecked={defaults.categoryIds.includes(h.id)} className="size-5 accent-primary" />
            )}
            {h.name}
          </label>
        ))}
        {state.fieldErrors?.categoryIds && <p className="text-sm text-destructive">{state.fieldErrors.categoryIds}</p>}
      </fieldset>
      {defaults.locked && <p className="text-xs text-muted-foreground">Approved concessions use this template, so its value and fee heads are fixed.</p>}
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save concession" : "Add concession"}
      </SubmitButton>
    </form>
  );
}

/** Propose a concession for one student (maker); someone else approves (checker). */
export function ProposeForm({ studentId, sessionId, concessions }: { studentId: string; sessionId: string; concessions: { id: string; label: string }[] }) {
  const [state, action] = useActionState(proposeConcessionAction, initialState);
  const [reason, setReason] = useState("");
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="academicSessionId" value={sessionId} />
      <SelectField id={`pr-${studentId}-c`} label="Concession" name="concessionId" options={concessions.map((c) => ({ value: c.id, label: c.label }))} required error={state.fieldErrors?.concessionId} />
      <div className="grid gap-1.5">
        <label htmlFor={`pr-${studentId}-r`} className="text-sm font-medium">
          Why (seen only by fee staff)
        </label>
        <textarea id={`pr-${studentId}-r`} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} className="min-h-20 rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" />
        {state.fieldErrors?.reason && <p className="text-sm text-destructive">{state.fieldErrors.reason}</p>}
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Proposing…">
        Propose
      </SubmitButton>
    </form>
  );
}

/** A manual extra charge on one installment (hostel, activity, a bounced-cheque charge…). */
export function ChargeForm({ studentId, sessionId, heads, installments }: { studentId: string; sessionId: string; heads: { id: string; name: string }[]; installments: { id: string; name: string }[] }) {
  const [state, action] = useActionState(addChargeAction, initialState);
  const id = (f: string) => `ch-${studentId}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="academicSessionId" value={sessionId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField id={id("cat")} label="Fee head" name="categoryId" options={heads.map((h) => ({ value: h.id, label: h.name }))} required error={state.fieldErrors?.categoryId} />
        <SelectField id={id("inst")} label="Installment" name="installmentId" options={installments.map((i) => ({ value: i.id, label: i.name }))} required error={state.fieldErrors?.installmentId} />
        <TextField id={id("amount")} label="Amount (₹)" name="amount" inputMode="decimal" required error={state.fieldErrors?.amount} />
        <TextField id={id("note")} label="What it is for" name="note" maxLength={200} required placeholder="e.g. Science club, term 1" error={state.fieldErrors?.note} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Adding…">
        Add charge
      </SubmitButton>
    </form>
  );
}
