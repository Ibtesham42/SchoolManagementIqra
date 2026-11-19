"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { markStudentDayAction } from "../actions";

const STATUSES = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "LATE", label: "Late" },
  { value: "HALF_DAY", label: "Half day" },
  { value: "EXCUSED", label: "Excused" },
] as const;

export interface StudentRow {
  enrollmentId: string;
  rollNumber: number | null;
  studentCode: string;
  fullName: string;
  status: string | null;
  version: number | null;
  /** false = shown read-only (a saved mark this user may not change). */
  editable: boolean;
}

function Picker({ row }: { row: StudentRow }) {
  const [status, setStatus] = useState(row.status ?? "PRESENT");
  return (
    <fieldset className="grid gap-2">
      <legend className="sr-only">Attendance for {row.fullName}</legend>
      <input type="hidden" name="enr" value={row.enrollmentId} />
      <input type="hidden" name={`ver:${row.enrollmentId}`} value={row.version === null ? "" : String(row.version)} />
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        {STATUSES.map((s) => (
          <label
            key={s.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm has-checked:border-primary has-checked:bg-primary has-checked:font-medium has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring pointer-fine:min-h-9"
          >
            <input type="radio" className="sr-only" name={`st:${row.enrollmentId}`} value={s.value} checked={status === s.value} onChange={() => setStatus(s.value)} />
            {s.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** AC6: everyone starts present; tap the exceptions and save once. AC7: saved marks change only as the rules allow. */
export function StudentDayForm({ sectionId, date, rows, reasonRequired }: { sectionId: string; date: string; rows: StudentRow[]; reasonRequired: boolean }) {
  const [state, action] = useActionState(markStudentDayAction, initialState);
  const editable = rows.filter((r) => r.editable);
  const LABEL: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
  return (
    <form action={action} className="grid gap-4 pb-24 md:pb-0">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="date" value={date} />
      <ul className="grid gap-3">
        {rows.map((r) => (
          <li key={r.enrollmentId} className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium">
                <span className="mr-2 tabular-nums text-muted-foreground">{r.rollNumber ?? "–"}</span>
                {r.fullName}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{r.studentCode}</span>
            </div>
            {r.editable ? <Picker row={r} /> : <p className="text-sm">{r.status ? `${LABEL[r.status] ?? r.status} (saved)` : "Not marked"}</p>}
          </li>
        ))}
      </ul>
      {reasonRequired && editable.some((r) => r.version !== null) && (
        <div className="grid gap-1.5">
          <label htmlFor="sa-reason" className="text-sm font-medium">
            Reason for changing saved marks
          </label>
          <textarea id="sa-reason" name="reason" maxLength={500} rows={2} className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" aria-invalid={state.fieldErrors?.reason ? true : undefined} />
          {state.fieldErrors?.reason && <p className="text-sm text-destructive">{state.fieldErrors.reason}</p>}
        </div>
      )}
      {editable.length > 0 && (
        <div className="sticky bottom-16 z-10 grid gap-2 rounded-lg border bg-background p-3 shadow-sm md:static md:border-0 md:p-0 md:shadow-none">
          <FormStatus state={state} />
          <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
            Save attendance ({editable.length})
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
