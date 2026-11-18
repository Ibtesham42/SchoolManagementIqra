"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createSessionAction, updateSessionAction } from "../actions";

export interface SessionDefaults {
  id?: string;
  name: string;
  startDate: string;
  endDate: string;
}

/** Create (no id) or edit a PLANNED session (id). The service re-checks shape, overlap and status. */
export function SessionForm({ defaults }: { defaults: SessionDefaults }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateSessionAction : createSessionAction, initialState);
  const fe = state.fieldErrors ?? {};
  const prefix = defaults.id ?? "new";
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      {defaults.id && <input type="hidden" name="id" value={defaults.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Name" id={`${prefix}-name`} name="name" defaultValue={defaults.name} placeholder="2026-27" hint="Format YYYY-YY." error={fe.name} required />
        <TextField label="Starts" id={`${prefix}-start`} name="startDate" type="date" defaultValue={defaults.startDate} error={fe.startDate} required />
        <TextField label="Ends" id={`${prefix}-end`} name="endDate" type="date" defaultValue={defaults.endDate} error={fe.endDate} required />
      </div>
      <SubmitButton className="w-full sm:w-fit">{editing ? "Save changes" : "Create session"}</SubmitButton>
    </form>
  );
}
