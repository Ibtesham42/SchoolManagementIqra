"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { copyStructureAction, createComponentAction, createStructureAction, updateComponentAction, updateStructureAction } from "./actions";

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const CHECK_ROW = "flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9";

export interface ComponentDefaults {
  id?: string;
  version?: number;
  code: string;
  name: string;
  kind: string;
  calc: string;
  prorated: boolean;
  /** Used by structures → code, type and calculation are fixed (service rule). */
  locked?: boolean;
}

/** Add (no id) or edit a salary component. Placeholders only suggest names — nothing is pre-filled (P1). */
export function ComponentForm({ defaults, idPrefix = "c" }: { defaults: ComponentDefaults; idPrefix?: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateComponentAction : createComponentAction, initialState);
  const id = (f: string) => `${idPrefix}-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField id={id("name")} label="Name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. House rent allowance, Provident fund"} error={state.fieldErrors?.name} />
      <TextField
        id={id("code")}
        label="Code"
        name="code"
        defaultValue={defaults.code}
        maxLength={20}
        required
        readOnly={defaults.locked}
        placeholder={editing ? undefined : "e.g. HRA, PF"}
        hint={defaults.locked ? "Fixed: salary structures use this component." : undefined}
        error={state.fieldErrors?.code}
      />
      {defaults.locked ? (
        <>
          <input type="hidden" name="kind" value={defaults.kind} />
          <input type="hidden" name="calc" value={defaults.calc} />
          <p className="text-sm text-muted-foreground">
            {defaults.kind === "EARNING" ? "Earning" : "Deduction"} · {defaults.calc === "FIXED" ? "fixed amount" : "% of basic"} (fixed once used)
          </p>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField id={id("kind")} label="Type" name="kind" defaultValue={defaults.kind || "EARNING"} options={[{ value: "EARNING", label: "Earning" }, { value: "DEDUCTION", label: "Deduction" }]} error={state.fieldErrors?.kind} />
          <SelectField id={id("calc")} label="Calculated as" name="calc" defaultValue={defaults.calc || "FIXED"} options={[{ value: "FIXED", label: "Fixed amount (₹)" }, { value: "PERCENT_OF_BASIC", label: "Percentage of basic" }]} error={state.fieldErrors?.calc} />
        </div>
      )}
      <label className={CHECK_ROW}>
        <input type="checkbox" name="prorated" defaultChecked={defaults.prorated} className="size-5 accent-primary" />
        Reduce for unpaid days (prorated by paid days)
      </label>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save component" : "Add component"}
      </SubmitButton>
    </form>
  );
}

interface ItemRow {
  key: number;
  componentId: string;
  value: string;
}

/** A salary structure: a name and its components with amounts (₹) or percentages of basic. */
export function StructureForm({
  defaults,
  components,
  idPrefix = "s",
}: {
  defaults: { id?: string; version?: number; name: string; items: { componentId: string; value: string }[] };
  components: { id: string; label: string; calc: string }[];
  idPrefix?: string;
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateStructureAction : createStructureAction, initialState);
  const [rows, setRows] = useState<ItemRow[]>(() => defaults.items.map((it, i) => ({ key: i, ...it })));
  const [next, setNext] = useState(defaults.items.length);
  const calcOf = new Map(components.map((c) => [c.id, c.calc]));
  const pid = `${idPrefix}-${defaults.id ?? "new"}`;
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField id={`${pid}-name`} label="Structure name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Teaching staff, Support staff"} error={state.fieldErrors?.name} />
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">Components (basic is set per employee)</legend>
        {rows.map((r) => (
          <div key={r.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm" htmlFor={`${pid}-c${r.key}`}>
              Component
              <select
                id={`${pid}-c${r.key}`}
                name="componentId"
                defaultValue={r.componentId}
                className={FIELD}
                onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, componentId: e.target.value } : x)))}
              >
                <option value="">Choose…</option>
                {components.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${pid}-v${r.key}`}>
              {calcOf.get(r.componentId) === "PERCENT_OF_BASIC" ? "% of basic" : "Amount (₹)"}
              <input id={`${pid}-v${r.key}`} name="value" inputMode="decimal" defaultValue={r.value} className={FIELD} />
            </label>
            <Button type="button" variant="outline" className="min-h-11" aria-label="Remove component" onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          className="min-h-11 justify-self-start"
          disabled={rows.length >= 30}
          onClick={() => {
            setRows([...rows, { key: next, componentId: "", value: "" }]);
            setNext(next + 1);
          }}
        >
          <Plus aria-hidden="true" /> Add component
        </Button>
        {state.fieldErrors?.items && <p className="text-sm text-destructive">{state.fieldErrors.items}</p>}
      </fieldset>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save structure" : "Add structure"}
      </SubmitButton>
    </form>
  );
}

/** Copy a structure under a new name (the way to change a structure that salaries already use). */
export function CopyStructureForm({ id, name }: { id: string; name: string }) {
  const [state, action] = useActionState(copyStructureAction, initialState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="id" value={id} />
      <TextField id={`copy-${id}`} label="Name of the copy" name="name" defaultValue={`${name} (new)`} maxLength={80} required error={state.fieldErrors?.name} />
      <SubmitButton variant="outline" className="min-h-11" pendingLabel="Copying…">
        Copy
      </SubmitButton>
      <div className="sm:col-span-2">
        <FormStatus state={state} />
      </div>
    </form>
  );
}
