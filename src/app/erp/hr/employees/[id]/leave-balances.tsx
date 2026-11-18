"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { setOpeningBalanceAction } from "../../actions";

/** One opening-balance form (L1): create (version empty) or correct an existing balance. */
export function OpeningBalanceForm({
  employeeId,
  academicSessionId,
  leaveTypeId,
  label,
  version,
  allotted,
  carriedForward,
}: {
  employeeId: string;
  academicSessionId: string;
  leaveTypeId: string;
  label: string;
  version: number | null;
  allotted: string;
  carriedForward: string;
}) {
  const [state, action] = useActionState(setOpeningBalanceAction, initialState);
  const fe = state.fieldErrors ?? {};
  const p = `ob-${leaveTypeId}`;
  return (
    <form
      action={action}
      className="grid gap-3 rounded-lg border p-3"
      noValidate
    >
      <FormStatus state={state} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="academicSessionId" value={academicSessionId} />
      <input type="hidden" name="leaveTypeId" value={leaveTypeId} />
      <input type="hidden" name="version" value={version ?? ""} />
      <p className="text-sm font-medium">{label}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Allotted days"
          id={`${p}-allotted`}
          name="allotted"
          inputMode="decimal"
          defaultValue={allotted}
          error={fe.allotted}
          required
        />
        <TextField
          label="Carried forward"
          id={`${p}-carry`}
          name="carriedForward"
          inputMode="decimal"
          defaultValue={carriedForward}
          error={fe.carriedForward}
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">
        {version === null ? "Set balance" : "Correct balance"}
      </SubmitButton>
    </form>
  );
}
