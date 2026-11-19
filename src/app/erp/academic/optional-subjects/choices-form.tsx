"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { setSubjectChoicesAction } from "../actions";

export interface RosterRow {
  enrollmentId: string;
  rollNumber: number | null;
  studentCode: string;
  fullName: string;
}

/** Tick the students who take this optional subject; one save replaces the section's choices for the subject. */
export function SubjectChoicesForm({
  sectionId,
  classSubjectId,
  roster,
  chosen,
  disabled,
}: {
  sectionId: string;
  classSubjectId: string;
  roster: RosterRow[];
  chosen: string[];
  disabled: boolean;
}) {
  const [state, action] = useActionState(setSubjectChoicesAction, initialState);
  const [picked, setPicked] = useState(() => new Set(chosen));
  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <form action={action} className="grid gap-3 pb-24 md:pb-0">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="classSubjectId" value={classSubjectId} />
      {chosen.map((id) => (
        <input key={id} type="hidden" name="expectedIds" value={id} />
      ))}
      {!disabled && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setPicked(new Set(roster.map((r) => r.enrollmentId)))}>
            Select all
          </Button>
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        </div>
      )}
      <fieldset disabled={disabled} className="grid gap-2">
        <legend className="sr-only">Students who take this subject</legend>
        {roster.map((r) => (
          <label key={r.enrollmentId} className="flex min-h-11 items-center gap-3 rounded-lg border px-3 text-sm has-checked:border-primary pointer-fine:min-h-9">
            <input
              type="checkbox"
              name="enrollmentIds"
              value={r.enrollmentId}
              checked={picked.has(r.enrollmentId)}
              onChange={() => toggle(r.enrollmentId)}
              className="size-5 shrink-0 accent-primary"
            />
            <span className="w-8 shrink-0 text-right tabular-nums text-muted-foreground">{r.rollNumber ?? "–"}</span>
            <span className="flex-1">{r.fullName}</span>
            <span className="font-mono text-xs text-muted-foreground">{r.studentCode}</span>
          </label>
        ))}
      </fieldset>
      {!disabled && (
        <div className="sticky bottom-16 z-10 grid gap-2 rounded-lg border bg-background p-3 shadow-sm md:static md:border-0 md:p-0 md:shadow-none">
          <FormStatus state={state} />
          <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
            Save choices ({picked.size} of {roster.length})
          </SubmitButton>
        </div>
      )}
    </form>
  );
}
