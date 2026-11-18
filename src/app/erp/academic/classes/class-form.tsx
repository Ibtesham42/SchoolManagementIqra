"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createClassAction, updateClassAction } from "../actions";

export interface ClassDefaults {
  id?: string;
  version?: number;
  code: string;
  name: string;
  numericLevel: string;
  displayOrder: string;
  defaultSectionCapacity: string;
  /** The code is fixed once the class has sections (service rule) — shown read-only then. */
  codeLocked?: boolean;
}

/** Create (no id) or edit a class. The service re-checks uniqueness, the code lock and the version. */
export function ClassForm({ defaults, schoolDefaultCapacity, idPrefix = "f" }: { defaults: ClassDefaults; schoolDefaultCapacity: number; idPrefix?: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateClassAction : createClassAction, initialState);
  const fe = state.fieldErrors ?? {};
  // Unique per rendering: the same class appears in the table (md+) and the card list (< md).
  const p = `${idPrefix}-${defaults.id ?? "new-class"}`;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      {defaults.id && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={defaults.version} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Class name" id={`${p}-name`} name="name" defaultValue={defaults.name} placeholder="Class 6" maxLength={60} error={fe.name} required />
        {defaults.codeLocked ? (
          <>
            <input type="hidden" name="code" value={defaults.code} />
            <TextField label="Code" id={`${p}-code`} name="code-display" defaultValue={defaults.code} readOnly hint="Fixed: this class already has sections." />
          </>
        ) : (
          <TextField
            label="Code"
            id={`${p}-code`}
            name="code"
            defaultValue={defaults.code}
            placeholder="C06"
            maxLength={10}
            autoCapitalize="characters"
            hint="Used in imports and reports, e.g. C06, C11-SCI. Can't change after sections exist."
            error={fe.code}
            required
          />
        )}
        <TextField
          label="Level"
          id={`${p}-level`}
          name="numericLevel"
          type="number"
          inputMode="numeric"
          min={-3}
          max={12}
          defaultValue={defaults.numericLevel}
          hint="1–12; 0 to −3 for pre-primary (UKG, LKG, Nursery, Pre-nursery). Streams share a level."
          error={fe.numericLevel}
          required
        />
        <TextField label="Display order" id={`${p}-order`} name="displayOrder" type="number" inputMode="numeric" min={0} max={999} defaultValue={defaults.displayOrder} hint="Lower numbers are listed first." error={fe.displayOrder} />
        <TextField
          label="Default section capacity (optional)"
          id={`${p}-capacity`}
          name="defaultSectionCapacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          defaultValue={defaults.defaultSectionCapacity}
          hint={`For new sections of this class. Empty uses the school default (${schoolDefaultCapacity}).`}
          error={fe.defaultSectionCapacity}
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">{editing ? "Save class" : "Create class"}</SubmitButton>
    </form>
  );
}
