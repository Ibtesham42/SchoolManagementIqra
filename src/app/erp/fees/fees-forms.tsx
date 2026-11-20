"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import {
  copyStructureAction,
  createCategoryAction,
  createInstallmentAction,
  createStructureAction,
  setLateFeeRuleAction,
  updateCategoryAction,
  updateFeeNumberFormatsAction,
  updateInstallmentAction,
  updateStructureAction,
} from "./actions";

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const APPLIES = [
  { value: "ALL", label: "Every student" },
  { value: "NEW_ADMISSION", label: "Only students admitted this session" },
  { value: "EXISTING", label: "Only students who were already here" },
];

/** Add (no id) or edit a fee head. Placeholders only suggest names — nothing is pre-filled (FC2). */
export function CategoryForm({ defaults }: { defaults: { id?: string; version?: number; code: string; name: string; kind: string; appliesTo: string } }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateCategoryAction : createCategoryAction, initialState);
  const id = (f: string) => `fc-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField id={id("name")} label="Name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Tuition fee, Admission fee"} error={state.fieldErrors?.name} />
      {!editing && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id={id("code")} label="Code" name="code" defaultValue={defaults.code} maxLength={20} required placeholder="e.g. TUITION" error={state.fieldErrors?.code} />
          <SelectField
            id={id("kind")}
            label="Type"
            name="kind"
            defaultValue={defaults.kind || "REGULAR"}
            options={[
              { value: "REGULAR", label: "Regular (every installment it's set for)" },
              { value: "ONE_TIME", label: "One-time" },
              { value: "OTHER", label: "Other" },
            ]}
            error={state.fieldErrors?.kind}
          />
        </div>
      )}
      <SelectField id={id("applies")} label="Who pays it" name="appliesTo" defaultValue={defaults.appliesTo || "ALL"} options={APPLIES} error={state.fieldErrors?.appliesTo} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save fee head" : "Add fee head"}
      </SubmitButton>
    </form>
  );
}

/** Receipt and invoice number formats (FC12) — required before invoices or receipts can be issued. */
export function NumberFormatsForm({ defaults }: { defaults: { feeReceipt: string; feeInvoice: string } }) {
  const [state, action] = useActionState(updateFeeNumberFormatsAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <TextField id="fmt-receipt" label="Receipt number format" name="feeReceipt" defaultValue={defaults.feeReceipt} maxLength={40} required placeholder="e.g. RCT/{YYYY}/{SEQ:5}" hint="Tokens: {CODE} {YYYY} {YY} and one {SEQ} or {SEQ:n}." error={state.fieldErrors?.feeReceipt} />
      <TextField id="fmt-invoice" label="Invoice number format" name="feeInvoice" defaultValue={defaults.feeInvoice} maxLength={40} required placeholder="e.g. INV/{SESSION}/{SEQ:5}" hint="Tokens: {CODE} {SESSION} {YYYY} {YY} and one {SEQ} or {SEQ:n}." error={state.fieldErrors?.feeInvoice} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save formats
      </SubmitButton>
    </form>
  );
}

/** Add (session) or edit (id) an installment. */
export function InstallmentForm({ sessionId, defaults, min, max }: { sessionId?: string; defaults: { id?: string; version?: number; name: string; dueOn: string; sortOrder: number }; min: string; max: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateInstallmentAction : createInstallmentAction, initialState);
  const id = (f: string) => `fi-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <input type="hidden" name="academicSessionId" value={sessionId} />
      )}
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <TextField id={id("name")} label="Name" name="name" defaultValue={defaults.name} maxLength={60} required placeholder={editing ? undefined : "e.g. April, Term 1"} error={state.fieldErrors?.name} />
        <TextField id={id("due")} label="Due date" name="dueOn" type="date" min={min} max={max} defaultValue={defaults.dueOn} required error={state.fieldErrors?.dueOn} />
        <TextField id={id("order")} label="Order" name="sortOrder" type="number" min={0} max={999} inputMode="numeric" defaultValue={String(defaults.sortOrder)} error={state.fieldErrors?.sortOrder} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save installment" : "Add installment"}
      </SubmitButton>
    </form>
  );
}

/** One late-fee rule per session (FC7). A per-day fee needs a maximum. */
export function LateFeeForm({ sessionId, defaults }: { sessionId: string; defaults: { graceDays: number; calc: string; value: string; cap: string } }) {
  const [state, action] = useActionState(setLateFeeRuleAction, initialState);
  const [calc, setCalc] = useState(defaults.calc || "FLAT");
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="academicSessionId" value={sessionId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="lf-calc"
          label="Charged as"
          name="calc"
          value={calc}
          onChange={(e) => setCalc(e.target.value)}
          options={[
            { value: "FLAT", label: "A fixed amount once (₹)" },
            { value: "PER_DAY", label: "An amount per day late (₹)" },
            { value: "PERCENT", label: "A percentage of what is unpaid" },
          ]}
          error={state.fieldErrors?.calc}
        />
        <TextField id="lf-grace" label="Days after the due date before it applies" name="graceDays" type="number" min={0} max={365} inputMode="numeric" defaultValue={String(defaults.graceDays)} required error={state.fieldErrors?.graceDays} />
        <TextField id="lf-value" label={calc === "PERCENT" ? "Percentage" : "Amount (₹)"} name="value" inputMode="decimal" defaultValue={defaults.value} required error={state.fieldErrors?.value} />
        <TextField id="lf-cap" label={calc === "PER_DAY" ? "Maximum (₹, required)" : "Maximum (₹, optional)"} name="cap" inputMode="decimal" defaultValue={defaults.cap} required={calc === "PER_DAY"} error={state.fieldErrors?.cap} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save late fee rule
      </SubmitButton>
    </form>
  );
}

interface ItemRow {
  key: number;
  categoryId: string;
  installmentId: string;
  amount: string;
}

/** A class fee structure: amounts per fee head per installment (FC3). */
export function StructureForm({
  sessionId,
  classes,
  defaults,
  categories,
  installments,
}: {
  sessionId?: string;
  classes?: { id: string; name: string }[];
  defaults: { id?: string; version?: number; name: string; items: { categoryId: string; installmentId: string; amount: string }[] };
  categories: { id: string; name: string }[];
  installments: { id: string; name: string }[];
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateStructureAction : createStructureAction, initialState);
  const [rows, setRows] = useState<ItemRow[]>(() => defaults.items.map((it, i) => ({ key: i, ...it })));
  const [next, setNext] = useState(defaults.items.length);
  const pid = `fs-${defaults.id ?? "new"}`;
  const addRows = (forAll: boolean) => {
    const last = rows[rows.length - 1];
    const add = forAll && last?.categoryId ? installments.filter((i) => !rows.some((r) => r.categoryId === last.categoryId && r.installmentId === i.id)).map((i, n) => ({ key: next + n, categoryId: last.categoryId, installmentId: i.id, amount: last.amount })) : [{ key: next, categoryId: "", installmentId: "", amount: "" }];
    setRows([...rows, ...add]);
    setNext(next + add.length);
  };
  return (
    <form action={action} className="grid gap-3">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <>
          <input type="hidden" name="academicSessionId" value={sessionId} />
          <SelectField id={`${pid}-class`} label="Class" name="classId" options={(classes ?? []).map((c) => ({ value: c.id, label: c.name }))} required error={state.fieldErrors?.classId} />
        </>
      )}
      <TextField id={`${pid}-name`} label="Structure name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Class 6 fees"} error={state.fieldErrors?.name} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Amounts</legend>
        {rows.map((r) => (
          <div key={r.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[2fr_2fr_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm" htmlFor={`${pid}-c${r.key}`}>
              Fee head
              <select id={`${pid}-c${r.key}`} name="categoryId" value={r.categoryId} className={FIELD} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, categoryId: e.target.value } : x)))}>
                <option value="">Choose…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${pid}-i${r.key}`}>
              Installment
              <select id={`${pid}-i${r.key}`} name="installmentId" value={r.installmentId} className={FIELD} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, installmentId: e.target.value } : x)))}>
                <option value="">Choose…</option>
                {installments.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${pid}-a${r.key}`}>
              Amount (₹)
              <input id={`${pid}-a${r.key}`} name="amount" inputMode="decimal" value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, amount: e.target.value } : x)))} className={FIELD} />
            </label>
            <Button type="button" variant="outline" className="min-h-11" aria-label="Remove amount" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" disabled={rows.length >= 400} onClick={() => addRows(false)}>
            <Plus aria-hidden="true" /> Add amount
          </Button>
          <Button type="button" variant="outline" className="min-h-11" disabled={rows.length >= 400 || !rows[rows.length - 1]?.categoryId} onClick={() => addRows(true)}>
            <Plus aria-hidden="true" /> Same amount for the other installments
          </Button>
        </div>
        {state.fieldErrors?.items && <p className="text-sm text-destructive">{state.fieldErrors.items}</p>}
      </fieldset>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save structure" : "Add structure"}
      </SubmitButton>
    </form>
  );
}

export function CopyStructureForm({ id, name }: { id: string; name: string }) {
  const [state, action] = useActionState(copyStructureAction, initialState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="id" value={id} />
      <TextField id={`fcopy-${id}`} label="Name of the copy" name="name" defaultValue={`${name} (new)`} maxLength={80} required error={state.fieldErrors?.name} />
      <SubmitButton variant="outline" className="min-h-11" pendingLabel="Copying…">
        Copy
      </SubmitButton>
      <div className="sm:col-span-2">
        <FormStatus state={state} />
      </div>
    </form>
  );
}
