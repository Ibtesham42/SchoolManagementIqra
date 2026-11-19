"use client";

import { useActionState, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { copyDayPlanAction, saveDayPlanAction, setSlotAction } from "../actions";

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

/** One period of one section: choose the subject (or none). The teacher follows the subject's allocation. */
export function SlotForm({
  sectionId,
  periodId,
  version,
  current,
  subjects,
  label,
}: {
  sectionId: string;
  periodId: string;
  version: number | null;
  current: string | null;
  subjects: { value: string; label: string }[];
  label: string;
}) {
  const [state, action] = useActionState(setSlotAction, initialState);
  const id = `slot-${periodId}`;
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="periodId" value={periodId} />
      <input type="hidden" name="version" value={version === null ? "" : String(version)} />
      <label className="grid gap-1.5 text-sm font-medium" htmlFor={id}>
        {label}
        <select id={id} name="classSubjectId" defaultValue={current ?? ""} className={FIELD}>
          <option value="">— Free —</option>
          {subjects.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <SubmitButton variant="outline" className="min-h-11" pendingLabel="Saving…">
        Save
      </SubmitButton>
      <div className="sm:col-span-2">
        <FormStatus state={state} />
      </div>
    </form>
  );
}

interface Row {
  key: number;
  startTime: string;
  endTime: string;
  kind: "TEACHING" | "BREAK";
  label: string;
  lessons: number;
}

/** One weekday's bell schedule. Rows are period 1, 2, 3 … in order; periods with lessons can't be removed. */
export function DayPlanForm({
  academicSessionId,
  dayOfWeek,
  fingerprint,
  periods,
  disabled,
}: {
  academicSessionId: string;
  dayOfWeek: number;
  fingerprint: string;
  periods: { startTime: string; endTime: string; kind: "TEACHING" | "BREAK"; label: string | null; lessons: number }[];
  disabled: boolean;
}) {
  const [state, action] = useActionState(saveDayPlanAction, initialState);
  const [rows, setRows] = useState<Row[]>(() => periods.map((p, i) => ({ key: i, ...p, label: p.label ?? "" })));
  const [next, setNext] = useState(periods.length);
  const add = () => {
    const last = rows.at(-1);
    setRows([...rows, { key: next, startTime: last?.endTime ?? "08:00", endTime: "", kind: "TEACHING", label: "", lessons: 0 }]);
    setNext(next + 1);
  };
  const prefix = `day${dayOfWeek}`;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="academicSessionId" value={academicSessionId} />
      <input type="hidden" name="dayOfWeek" value={String(dayOfWeek)} />
      <input type="hidden" name="fingerprint" value={fingerprint} />
      {rows.length === 0 && <p className="text-sm text-muted-foreground">No periods. This day is free (e.g. a weekly off).</p>}
      <ol className="grid gap-2">
        {rows.map((r, i) => (
          <li key={r.key} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[3rem_1fr_1fr_1fr_1.5fr_auto] sm:items-end">
            <span className="text-sm font-medium sm:self-center">P{i + 1}</span>
            <label className="grid gap-1 text-sm" htmlFor={`${prefix}-s${r.key}`}>
              Start
              <input id={`${prefix}-s${r.key}`} type="time" name="startTime" defaultValue={r.startTime} required disabled={disabled} className={FIELD} />
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${prefix}-e${r.key}`}>
              End
              <input id={`${prefix}-e${r.key}`} type="time" name="endTime" defaultValue={r.endTime} required disabled={disabled} className={FIELD} />
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${prefix}-k${r.key}`}>
              Type
              <select id={`${prefix}-k${r.key}`} name="kind" defaultValue={r.kind} disabled={disabled} className={FIELD}>
                <option value="TEACHING">Lesson</option>
                <option value="BREAK" disabled={r.lessons > 0}>
                  Break
                </option>
              </select>
            </label>
            <label className="grid gap-1 text-sm" htmlFor={`${prefix}-l${r.key}`}>
              Label (optional)
              <input id={`${prefix}-l${r.key}`} name="label" defaultValue={r.label} maxLength={40} placeholder="e.g. Assembly, Lunch" disabled={disabled} className={FIELD} />
            </label>
            {!disabled && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={r.lessons > 0}
                aria-label={`Remove period ${i + 1}`}
                title={r.lessons > 0 ? "This period has lessons" : undefined}
                onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            )}
          </li>
        ))}
      </ol>
      {!disabled && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" className="min-h-11" onClick={add} disabled={rows.length >= 15}>
            <Plus aria-hidden="true" /> Add period
          </Button>
          <SubmitButton className="min-h-11" pendingLabel="Saving…">
            Save day
          </SubmitButton>
        </div>
      )}
      <FormStatus state={state} />
    </form>
  );
}

export function CopyDayForm({ academicSessionId, days }: { academicSessionId: string; days: { value: number; label: string; fingerprint: string }[] }) {
  const [state, action] = useActionState(copyDayPlanAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="academicSessionId" value={academicSessionId} />
      {days.map((d) => (
        <input key={d.value} type="hidden" name={`fp:${d.value}`} value={d.fingerprint} />
      ))}
      <label className="grid gap-1.5 text-sm font-medium" htmlFor="copy-from">
        Copy the periods of
        <select id="copy-from" name="fromDay" defaultValue="1" className={FIELD}>
          {days.map((d) => (
            <option key={d.value} value={d.value}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">to</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {days.map((d) => (
            <label key={d.value} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9">
              <input type="checkbox" name="toDays" value={d.value} className="size-5 accent-primary" />
              {d.label}
            </label>
          ))}
        </div>
        {state.fieldErrors?.toDays && <p className="text-sm text-destructive">{state.fieldErrors.toDays}</p>}
      </fieldset>
      <p className="text-xs text-muted-foreground">The chosen days&apos; periods are replaced. Days that already have lessons are refused.</p>
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="min-h-11 w-full sm:w-auto" pendingLabel="Copying…">
        Copy periods
      </SubmitButton>
    </form>
  );
}
