"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { markAttendanceDayAction } from "./actions";

const STATUSES = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "Absent" },
  { value: "LATE", label: "Late" },
  { value: "HALF_DAY", label: "Half day" },
] as const;
const TIME_INPUT = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const TEXTAREA = "min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm";

export interface MarkRow {
  id: string;
  employeeCode: string;
  fullName: string;
  subtitle: string;
  status: string | null;
  checkIn: string | null;
  checkOut: string | null;
  version: number | null;
}

/** Status buttons (radios — work without JavaScript) plus optional times for one employee. */
function StatusPicker({ row, prefix }: { row: MarkRow; prefix: string }) {
  const [status, setStatus] = useState(row.status ?? "PRESENT");
  const absent = status === "ABSENT";
  return (
    <fieldset className="grid gap-2">
      <legend className="sr-only">Attendance for {row.fullName}</legend>
      <input type="hidden" name="emp" value={row.id} />
      <input type="hidden" name={`ver:${row.id}`} value={row.version === null ? "" : String(row.version)} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STATUSES.map((s) => (
          <label
            key={s.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm has-checked:border-primary has-checked:bg-primary has-checked:font-medium has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring pointer-fine:min-h-9"
          >
            <input
              type="radio"
              className="sr-only"
              name={`status:${row.id}`}
              value={s.value}
              checked={status === s.value}
              onChange={() => setStatus(s.value)}
            />
            {s.label}
          </label>
        ))}
      </div>
      {!absent && (
        <details className="text-sm" open={row.checkIn !== null || row.checkOut !== null}>
          <summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground pointer-fine:min-h-9">
            Times (optional)
          </summary>
          <div className="grid grid-cols-2 gap-2 pt-1">
            <label className="grid gap-1" htmlFor={`${prefix}-in-${row.id}`}>
              <span>Check-in</span>
              <input id={`${prefix}-in-${row.id}`} type="time" name={`in:${row.id}`} defaultValue={row.checkIn ?? ""} className={TIME_INPUT} />
            </label>
            <label className="grid gap-1" htmlFor={`${prefix}-out-${row.id}`}>
              <span>Check-out</span>
              <input id={`${prefix}-out-${row.id}`} type="time" name={`out:${row.id}`} defaultValue={row.checkOut ?? ""} className={TIME_INPUT} />
            </label>
          </div>
        </details>
      )}
    </fieldset>
  );
}

function ReasonField({ id, required, error }: { id: string; required?: boolean; error?: string }) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Reason for changes{required ? "" : " (only when changing saved marks)"}
      </label>
      <textarea
        id={id}
        name="reason"
        maxLength={500}
        rows={2}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className={TEXTAREA}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** L7: everyone starts as Present; tap the exceptions, then save once. Leave, holidays and own row are not editable. */
export function MarkDayForm({ date, rows, hasSaved }: { date: string; rows: MarkRow[]; hasSaved: boolean }) {
  const [state, action] = useActionState(markAttendanceDayAction, initialState);
  return (
    <form action={action} className="grid gap-4 pb-24 md:pb-0">
      <input type="hidden" name="date" value={date} />
      <ul className="grid gap-3">
        {rows.map((r) => (
          <li key={r.id} className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium">{r.fullName}</span>
              <span className="font-mono text-xs text-muted-foreground">{r.employeeCode}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {r.subtitle}
              {r.status !== null ? " · saved" : ""}
            </p>
            <StatusPicker row={r} prefix="d" />
          </li>
        ))}
      </ul>
      {hasSaved && <ReasonField id="mark-reason" error={state.fieldErrors?.reason} />}
      <div className="sticky bottom-16 z-10 grid gap-2 rounded-lg border bg-background p-3 shadow-sm md:static md:border-0 md:p-0 md:shadow-none">
        <FormStatus state={state} />
        <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
          Save attendance ({rows.length})
        </SubmitButton>
      </div>
    </form>
  );
}

/** L8: correct (or mark late) a single day for one employee from the month view. Reason required for saved rows. */
export function CorrectDayForm({ date, row }: { date: string; row: MarkRow }) {
  const [state, action] = useActionState(markAttendanceDayAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="date" value={date} />
      <StatusPicker row={row} prefix={`c-${date}`} />
      {row.version !== null && <ReasonField id={`reason-${date}`} required error={state.fieldErrors?.reason} />}
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {row.version === null ? "Save" : "Save correction"}
      </SubmitButton>
    </form>
  );
}
