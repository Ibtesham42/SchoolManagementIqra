"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { reportCardRemarkAction } from "../../../actions";

/** AC15: the class teacher's remark, printed on the report card. Blank removes it. */
export function RemarkForm({ id, version, remark, studentName }: { id: string; version: number; remark: string | null; studentName: string }) {
  const [state, action] = useActionState(reportCardRemarkAction, initialState);
  const fieldId = `rm-${id}`;
  const [text, setText] = useState(remark ?? ""); // controlled: survives React 19's form reset
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <label htmlFor={fieldId} className="text-sm font-medium">
        Class teacher&apos;s remark for {studentName}
      </label>
      <textarea id={fieldId} name="remark" value={text} onChange={(e) => setText(e.target.value)} maxLength={300} rows={2} className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" aria-invalid={state.fieldErrors?.remark ? true : undefined} />
      {state.fieldErrors?.remark && <p className="text-sm text-destructive">{state.fieldErrors.remark}</p>}
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save remark
      </SubmitButton>
    </form>
  );
}
