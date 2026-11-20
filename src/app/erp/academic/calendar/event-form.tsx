"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createEventAction, updateEventAction } from "../actions";

/** Add (academicSessionId) or edit (id + version) an academic calendar event (AC18). */
export function EventForm({ defaults, min, max }: { defaults: { id?: string; version?: number; academicSessionId?: string; title: string; startDate: string; endDate: string; details: string }; min: string; max: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateEventAction : createEventAction, initialState);
  const [v, setV] = useState({ title: defaults.title, startDate: defaults.startDate, endDate: defaults.endDate, details: defaults.details });
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((cur) => ({ ...cur, [k]: e.target.value }));
  const id = (f: string) => `ev-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <input type="hidden" name="academicSessionId" value={defaults.academicSessionId} />
      )}
      <TextField id={id("title")} label="Event" name="title" value={v.title} onChange={set("title")} maxLength={120} required placeholder={editing ? undefined : "e.g. Sports day"} error={state.fieldErrors?.title} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={id("start")} label="From" name="startDate" type="date" min={min} max={max} value={v.startDate} onChange={set("startDate")} required error={state.fieldErrors?.startDate} />
        <TextField id={id("end")} label="To (optional)" name="endDate" type="date" min={min} max={max} value={v.endDate} onChange={set("endDate")} error={state.fieldErrors?.endDate} />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={id("details")} className="text-sm font-medium">
          Details (optional)
        </label>
        <textarea id={id("details")} name="details" value={v.details} onChange={set("details")} maxLength={1000} rows={2} className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" />
        {state.fieldErrors?.details && <p className="text-sm text-destructive">{state.fieldErrors.details}</p>}
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save event" : "Add event"}
      </SubmitButton>
    </form>
  );
}
