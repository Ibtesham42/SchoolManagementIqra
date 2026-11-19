"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { assignTeacherAction } from "../actions";

/** Allocate (or change) the teacher of one subject in one section. The service re-checks the teacher under locks. */
export function AssignTeacherForm({
  sectionId,
  classSubjectId,
  version,
  currentEmployeeId,
  teachers,
  idPrefix,
}: {
  sectionId: string;
  classSubjectId: string;
  version: number | null;
  currentEmployeeId: string | null;
  teachers: { value: string; label: string }[];
  idPrefix: string;
}) {
  const [state, action] = useActionState(assignTeacherAction, initialState);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="classSubjectId" value={classSubjectId} />
      <input type="hidden" name="version" value={version === null ? "" : String(version)} />
      <SelectField
        id={`${idPrefix}-${classSubjectId}`}
        label="Teacher"
        name="employeeId"
        options={[{ value: "", label: "Choose…" }, ...teachers]}
        defaultValue={currentEmployeeId ?? ""}
        required
        error={state.fieldErrors?.employeeId}
      />
      <SubmitButton className="min-h-11" pendingLabel="Saving…">
        {version === null ? "Allocate" : "Change"}
      </SubmitButton>
      <div className="sm:col-span-2">
        <FormStatus state={state} />
      </div>
    </form>
  );
}
