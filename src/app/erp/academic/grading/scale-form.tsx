"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createScaleAction, updateScaleAction } from "../actions";

export interface BandDefaults {
  minPercent: string;
  grade: string;
  gradePoint: string;
  remark: string;
}

const SPARE_ROWS = 3;
const MAX_ROWS = 20;
const EMPTY: BandDefaults = { minPercent: "", grade: "", gradePoint: "", remark: "" };

/**
 * Add (no id) or edit a grading scale. Each band starts at its minimum percent and runs to the next band; the lowest
 * band must start at 0. Blank rows are ignored. The service re-validates the bands and refuses band edits once an
 * exam uses the scale (`locked`).
 */
export function ScaleForm({ defaults, idPrefix = "g" }: { defaults: { id?: string; version?: number; name: string; bands: BandDefaults[]; locked?: boolean }; idPrefix?: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateScaleAction : createScaleAction, initialState);
  const id = (f: string) => `${idPrefix}-${defaults.id ?? "new"}-${f}`;
  const spare = defaults.bands.length === 0 ? 8 : SPARE_ROWS;
  const rows = defaults.locked ? defaults.bands : [...defaults.bands, ...Array.from({ length: spare }, () => EMPTY)].slice(0, MAX_ROWS);
  const bandError = Object.entries(state.fieldErrors ?? {}).find(([k]) => k.startsWith("bands"))?.[1];
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField id={id("name")} label="Scale name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Primary grades"} error={state.fieldErrors?.name} />
      <fieldset className="grid gap-3" aria-describedby={bandError ? id("bands-error") : id("bands-hint")}>
        <legend className="text-sm font-medium">Bands</legend>
        <p id={id("bands-hint")} className="text-xs text-muted-foreground">
          {defaults.locked
            ? "Fixed: exams already use this scale. Create a new scale to grade differently."
            : "One row per grade, from the lowest. A band starts at its minimum percent and runs to the next band; the lowest starts at 0. Leave spare rows blank."}
        </p>
        {rows.map((b, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 rounded-lg border p-3 sm:grid-cols-4">
            <TextField id={id(`b${i}-min`)} label={`Band ${i + 1}: from %`} name={`band-${i}-min`} defaultValue={b.minPercent} inputMode="decimal" maxLength={6} readOnly={defaults.locked} />
            <TextField id={id(`b${i}-grade`)} label="Grade" name={`band-${i}-grade`} defaultValue={b.grade} maxLength={5} readOnly={defaults.locked} />
            <TextField id={id(`b${i}-point`)} label="Grade point" name={`band-${i}-point`} defaultValue={b.gradePoint} inputMode="decimal" maxLength={4} readOnly={defaults.locked} />
            <TextField id={id(`b${i}-remark`)} label="Remark" name={`band-${i}-remark`} defaultValue={b.remark} maxLength={60} readOnly={defaults.locked} />
          </div>
        ))}
        {bandError && (
          <p id={id("bands-error")} className="text-sm text-destructive">
            {bandError}
          </p>
        )}
      </fieldset>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save scale" : "Add scale"}
      </SubmitButton>
    </form>
  );
}
