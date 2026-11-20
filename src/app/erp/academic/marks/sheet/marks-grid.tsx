"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { saveMarksAction } from "../../actions";

export interface GridRow {
  enrollmentId: string;
  rollNumber: number | null;
  studentCode: string;
  fullName: string;
  status: "PRESENT" | "ABSENT" | "EXEMPT";
  theory: string;
  practical: string;
  internal: string;
  version: number | null;
  corrected: boolean;
}

const STATUSES = [
  { value: "PRESENT", label: "Present" },
  { value: "ABSENT", label: "AB" },
  { value: "EXEMPT", label: "EX" },
] as const;
const INPUT = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base tabular-nums disabled:opacity-50 sm:pointer-fine:h-9 sm:text-sm";

function Row({ row, max, error }: { row: GridRow; max: { theory: number; practical: number; internal: number }; error?: string }) {
  const [status, setStatus] = useState(row.status);
  // Controlled: React 19 resets uncontrolled fields after a form action, which would lose typed marks on an error.
  const [values, setValues] = useState<Record<string, string>>({ th: row.theory, pr: row.practical, in: row.internal });
  const parts = [
    { key: "th", label: "Theory", max: max.theory },
    { key: "pr", label: "Practical", max: max.practical },
    { key: "in", label: "Internal", max: max.internal },
  ].filter((p) => p.max > 0);
  const id = row.enrollmentId;
  return (
    <li className={`grid gap-2 rounded-lg border p-3 ${error ? "border-destructive" : ""}`}>
      <input type="hidden" name="enr" value={id} />
      <input type="hidden" name={`ver:${id}`} value={row.version === null ? "" : String(row.version)} />
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="font-medium">
          <span className="mr-2 tabular-nums text-muted-foreground">{row.rollNumber ?? "–"}</span>
          {row.fullName}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {row.studentCode}
          {row.corrected && " · corrected"}
        </span>
      </div>
      <fieldset className="grid grid-cols-3 gap-2">
        <legend className="sr-only">Attendance in this exam for {row.fullName}</legend>
        {STATUSES.map((s) => (
          <label
            key={s.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm has-checked:border-primary has-checked:bg-primary has-checked:font-medium has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring pointer-fine:min-h-9"
          >
            <input type="radio" className="sr-only" name={`st:${id}`} value={s.value} checked={status === s.value} onChange={() => setStatus(s.value)} />
            {s.label}
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-3 gap-2">
        {parts.map((p) => (
          <label key={p.key} className="grid gap-1 text-xs font-medium" htmlFor={`${p.key}-${id}`}>
            {p.label} (/{p.max})
            <input id={`${p.key}-${id}`} name={`${p.key}:${id}`} value={values[p.key]} onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))} inputMode="decimal" maxLength={6} autoComplete="off" disabled={status !== "PRESENT"} className={INPUT} />
          </label>
        ))}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  );
}

/**
 * The marks grid: one card per student (works at 360 px), saved in one batch. Partial saves are fine while the sheet is
 * open; corrections of approved marks need every mark and a reason.
 */
export function MarksGrid({ examSubjectId, sectionId, sheetVersion, rows, max, correction }: { examSubjectId: string; sectionId: string; sheetVersion: number | null; rows: GridRow[]; max: { theory: number; practical: number; internal: number }; correction: boolean }) {
  const [state, action] = useActionState(saveMarksAction, initialState);
  const rowError = (id: string) => state.fieldErrors?.[`entries.${id}`];
  return (
    <form action={action} className="grid gap-4 pb-24 md:pb-0">
      <input type="hidden" name="examSubjectId" value={examSubjectId} />
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="sheetVersion" value={sheetVersion === null ? "" : String(sheetVersion)} />
      <ul className="grid gap-3">
        {rows.map((r) => (
          <Row key={r.enrollmentId} row={r} max={max} error={rowError(r.enrollmentId)} />
        ))}
      </ul>
      {correction && (
        <div className="grid gap-1.5">
          <label htmlFor="mk-reason" className="text-sm font-medium">
            Reason for correcting approved marks
          </label>
          <textarea id="mk-reason" name="reason" maxLength={500} rows={2} required className="min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" aria-invalid={state.fieldErrors?.reason ? true : undefined} />
          {state.fieldErrors?.reason && <p className="text-sm text-destructive">{state.fieldErrors.reason}</p>}
        </div>
      )}
      <div className="sticky bottom-16 z-10 grid gap-2 rounded-lg border bg-background p-3 shadow-sm md:static md:border-0 md:p-0 md:shadow-none">
        <FormStatus state={state} />
        <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
          {correction ? "Save corrections" : `Save marks (${rows.length})`}
        </SubmitButton>
      </div>
    </form>
  );
}
