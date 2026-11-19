"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createSubjectAction, updateSubjectAction } from "../actions";

export interface SubjectDefaults {
  id?: string;
  version?: number;
  code: string;
  name: string;
  kind: string;
  /** Once a class studies the subject, its code and type are fixed (service rule). */
  locked?: boolean;
}

const KIND_OPTIONS = [
  { value: "SCHOLASTIC", label: "Scholastic (marks count towards results)" },
  { value: "CO_SCHOLASTIC", label: "Co-scholastic (activities, graded separately)" },
];

/** Add (no id) or edit a subject. The service re-checks uniqueness, the lock and the version. */
export function SubjectForm({ defaults, idPrefix = "s" }: { defaults: SubjectDefaults; idPrefix?: string }) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateSubjectAction : createSubjectAction, initialState);
  const id = (f: string) => `${idPrefix}-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      )}
      <TextField
        id={id("name")}
        label="Subject name"
        name="name"
        defaultValue={defaults.name}
        maxLength={80}
        required
        placeholder={editing ? undefined : "e.g. Mathematics, English, हिन्दी"}
        error={state.fieldErrors?.name}
      />
      <TextField
        id={id("code")}
        label="Code"
        name="code"
        defaultValue={defaults.code}
        maxLength={20}
        required
        readOnly={defaults.locked}
        autoCapitalize="characters"
        placeholder={editing ? undefined : "e.g. MATH, ENG, HIN"}
        hint={defaults.locked ? "Fixed: classes already study this subject." : "Letters and digits; used in reports and imports."}
        error={state.fieldErrors?.code}
      />
      {defaults.locked ? (
        <>
          <input type="hidden" name="kind" value={defaults.kind} />
          <p className="text-sm text-muted-foreground">Type: {KIND_OPTIONS.find((k) => k.value === defaults.kind)?.label} (fixed once used).</p>
        </>
      ) : (
        <SelectField id={id("kind")} label="Type" name="kind" options={KIND_OPTIONS} defaultValue={defaults.kind || "SCHOLASTIC"} error={state.fieldErrors?.kind} />
      )}
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save subject" : "Add subject"}
      </SubmitButton>
    </form>
  );
}
