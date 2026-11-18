"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { correctRollNumberAction, finalizeRollNumbersAction } from "./actions";

/** Type-to-confirm finalization (D3): the section code must be typed; the server checks it again. */
export function FinalizeForm({ sectionId, version, sectionCode, stale }: { sectionId: string; version: number; sectionCode: string; stale: boolean }) {
  const [state, action] = useActionState(finalizeRollNumbersAction, initialState);
  if (state.ok) return <FormStatus state={state} />;
  return (
    <form action={action} className="grid gap-3">
      <FormStatus state={state} />
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="version" value={version} />
      <p className="text-sm">
        After finalizing, these numbers never change automatically. Students admitted later get the next number. Only a Principal can correct a number, with a reason.
      </p>
      <div className="sm:w-72">
        <TextField
          label={`Type ${sectionCode} to confirm`}
          name="confirm"
          autoComplete="off"
          autoCapitalize="characters"
          error={state.fieldErrors?.confirm}
          disabled={stale}
          required
        />
      </div>
      <SubmitButton className="w-full sm:w-fit" disabled={stale}>
        Finalize roll numbers
      </SubmitButton>
    </form>
  );
}

/** One correction at a time: a student, a free number and a reason (audited before/after). */
export function CorrectionForm({ sectionId, version, students }: { sectionId: string; version: number; students: { value: string; label: string }[] }) {
  const [state, action] = useActionState(correctRollNumberAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-3">
      <FormStatus state={state} />
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="version" value={version} />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField label="Student" name="enrollmentId" options={[{ value: "", label: "Choose a student" }, ...students]} defaultValue="" error={fe.enrollmentId} required />
        <TextField label="New roll number" name="rollNumber" type="number" inputMode="numeric" min={1} max={999} error={fe.rollNumber} required />
        <TextField label="Reason" name="reason" maxLength={500} error={fe.reason} required />
      </div>
      <SubmitButton variant="outline" className="w-full sm:w-fit">
        Correct roll number
      </SubmitButton>
    </form>
  );
}
