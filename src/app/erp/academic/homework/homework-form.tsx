"use client";

import { useActionState, useState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createHomeworkAction, updateHomeworkAction } from "../actions";

/** Post (sectionId + subject choice) or edit (id + version) homework. Text only (attachments later, KI-094). */
export function HomeworkForm({
  sectionId,
  subjects,
  defaults,
  minDue,
  maxDue,
}: {
  sectionId?: string;
  subjects?: { id: string; name: string }[];
  defaults: { id?: string; version?: number; title: string; details: string; dueOn: string };
  minDue: string;
  maxDue: string;
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateHomeworkAction : createHomeworkAction, initialState);
  // Controlled: React 19 resets uncontrolled fields after a form action, which would lose typed text on an error.
  const [title, setTitle] = useState(defaults.title);
  const [details, setDetails] = useState(defaults.details);
  const [dueOn, setDueOn] = useState(defaults.dueOn);
  const id = (f: string) => `hw-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <>
          <input type="hidden" name="sectionId" value={sectionId} />
          <SelectField id={id("subject")} label="Subject" name="classSubjectId" options={(subjects ?? []).map((s) => ({ value: s.id, label: s.name }))} error={state.fieldErrors?.classSubjectId} required />
        </>
      )}
      <TextField id={id("title")} label="Title" name="title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} required error={state.fieldErrors?.title} />
      <div className="grid gap-1.5">
        <label htmlFor={id("details")} className="text-sm font-medium">
          What to do
        </label>
        <textarea
          id={id("details")}
          name="details"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          maxLength={4000}
          rows={4}
          required
          className="min-h-28 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm"
          aria-invalid={state.fieldErrors?.details ? true : undefined}
          aria-describedby={state.fieldErrors?.details ? id("details-error") : undefined}
        />
        {state.fieldErrors?.details && (
          <p id={id("details-error")} className="text-sm text-destructive">
            {state.fieldErrors.details}
          </p>
        )}
      </div>
      <TextField id={id("due")} label="Due on" name="dueOn" type="date" min={minDue} max={maxDue} value={dueOn} onChange={(e) => setDueOn(e.target.value)} required error={state.fieldErrors?.dueOn} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save homework" : "Post homework"}
      </SubmitButton>
    </form>
  );
}
