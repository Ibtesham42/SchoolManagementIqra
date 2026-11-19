"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { addClassSubjectsAction, copyClassSubjectsAction, updateClassSubjectAction } from "../actions";

const CHECK = "size-5 shrink-0 accent-primary";
const CHECK_ROW = "flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9";

/** Add one or more active subjects to the class, all compulsory or all optional. */
export function AddClassSubjectsForm({
  academicSessionId,
  classId,
  available,
}: {
  academicSessionId: string;
  classId: string;
  available: { id: string; label: string }[];
}) {
  const [state, action] = useActionState(addClassSubjectsAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="academicSessionId" value={academicSessionId} />
      <input type="hidden" name="classId" value={classId} />
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Subjects to add</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {available.map((s) => (
            <label key={s.id} className={CHECK_ROW}>
              <input type="checkbox" name="subjectIds" value={s.id} className={CHECK} />
              {s.label}
            </label>
          ))}
        </div>
        {state.fieldErrors?.subjectIds && <p className="text-sm text-destructive">{state.fieldErrors.subjectIds}</p>}
      </fieldset>
      <label className={CHECK_ROW}>
        <input type="checkbox" name="isOptional" className={CHECK} />
        Optional — each student chooses whether to take it
      </label>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Adding…">
        Add to class
      </SubmitButton>
    </form>
  );
}

/** Compulsory / optional and the order on report cards and timetables. */
export function EditClassSubjectForm({ row, idPrefix }: { row: { id: string; version: number; isOptional: boolean; sortOrder: number }; idPrefix: string }) {
  const [state, action] = useActionState(updateClassSubjectAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="version" value={String(row.version)} />
      <label className={CHECK_ROW}>
        <input type="checkbox" name="isOptional" defaultChecked={row.isOptional} className={CHECK} />
        Optional
      </label>
      <TextField
        id={`${idPrefix}-${row.id}-order`}
        label="Order"
        name="sortOrder"
        type="number"
        inputMode="numeric"
        min={0}
        max={999}
        defaultValue={String(row.sortOrder)}
        hint="Lower numbers come first."
        error={state.fieldErrors?.sortOrder}
      />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save
      </SubmitButton>
    </form>
  );
}

/** Copy every class's subjects from another session into this one (existing mappings are kept). */
export function CopyClassSubjectsForm({ toSessionId, sources }: { toSessionId: string; sources: { value: string; label: string }[] }) {
  const [state, action] = useActionState(copyClassSubjectsAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="toSessionId" value={toSessionId} />
      <SelectField id="copy-cs-from" label="Copy from session" name="fromSessionId" options={sources} error={state.fieldErrors?.fromSessionId} />
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="min-h-11 w-full sm:w-auto" pendingLabel="Copying…">
        Copy all classes&apos; subjects
      </SubmitButton>
    </form>
  );
}
