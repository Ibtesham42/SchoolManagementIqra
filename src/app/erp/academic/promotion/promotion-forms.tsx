"use client";

import { useActionState, useState } from "react";
import { FormStatus, SelectField, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { confirmPromotionsAction, proposePromotionsAction } from "../actions";

export interface PromotionRow {
  enrollmentId: string;
  rollNumber: number | null;
  studentCode: string;
  fullName: string;
  editable: boolean;
  decision: "PROMOTE" | "DETAIN" | "LEAVE";
  toClassId: string;
  leaveAs: string;
  version: number | null;
  summary: string | null;
}

const DECISIONS = [
  { value: "PROMOTE", label: "Promote" },
  { value: "DETAIN", label: "Detain" },
  { value: "LEAVE", label: "Leave" },
] as const;
const LEAVE_AS = [
  { value: "", label: "Choose why" },
  { value: "GRADUATED", label: "Graduated (completed school)" },
  { value: "TRANSFERRED", label: "Transferred" },
  { value: "WITHDRAWN", label: "Withdrawn" },
];

function Row({ row, nextClasses, canPromote, error }: { row: PromotionRow; nextClasses: { id: string; name: string }[]; canPromote: boolean; error?: string }) {
  const [decision, setDecision] = useState(row.decision);
  const [toClassId, setToClassId] = useState(row.toClassId);
  const [leaveAs, setLeaveAs] = useState(row.leaveAs);
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
        <span className="font-mono text-xs text-muted-foreground">{row.studentCode}</span>
      </div>
      <fieldset className="grid grid-cols-3 gap-2">
        <legend className="sr-only">Decision for {row.fullName}</legend>
        {DECISIONS.filter((d) => d.value !== "PROMOTE" || canPromote).map((d) => (
          <label
            key={d.value}
            className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border px-2 text-sm has-checked:border-primary has-checked:bg-primary has-checked:font-medium has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring pointer-fine:min-h-9"
          >
            <input type="radio" className="sr-only" name={`dec:${id}`} value={d.value} checked={decision === d.value} onChange={() => setDecision(d.value)} />
            {d.label}
          </label>
        ))}
      </fieldset>
      {decision === "PROMOTE" && nextClasses.length > 1 && (
        <SelectField id={`cls-${id}`} label="Next class" name={`cls:${id}`} value={toClassId} onChange={(e) => setToClassId(e.target.value)} options={[{ value: "", label: "Choose a class" }, ...nextClasses.map((c) => ({ value: c.id, label: c.name }))]} />
      )}
      {decision === "LEAVE" && <SelectField id={`leave-${id}`} label="Leaving because" name={`leave:${id}`} value={leaveAs} onChange={(e) => setLeaveAs(e.target.value)} options={LEAVE_AS} />}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  );
}

/** AC16: the class teacher proposes; everything starts as Promote (or Leave → graduated at the top level). */
export function ProposeForm({ sectionId, rows, nextClasses, canPromote }: { sectionId: string; rows: PromotionRow[]; nextClasses: { id: string; name: string }[]; canPromote: boolean }) {
  const [state, action] = useActionState(proposePromotionsAction, initialState);
  const editable = rows.filter((r) => r.editable);
  return (
    <form action={action} className="grid gap-4 pb-24 md:pb-0">
      <input type="hidden" name="sectionId" value={sectionId} />
      <ul className="grid gap-3">
        {rows.map((r) =>
          r.editable ? (
            <Row key={r.enrollmentId} row={r} nextClasses={nextClasses} canPromote={canPromote} error={state.fieldErrors?.[`entries.${r.enrollmentId}`]} />
          ) : (
            <li key={r.enrollmentId} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border p-3 text-sm">
              <span className="font-medium">{r.fullName}</span>
              <span className="text-muted-foreground">{r.summary ?? "Confirmed"}</span>
            </li>
          ),
        )}
      </ul>
      {editable.length > 0 && (
        <div className="sticky bottom-16 z-10 grid gap-2 rounded-lg border bg-background p-3 shadow-sm md:static md:border-0 md:p-0 md:shadow-none">
          <FormStatus state={state} />
          <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
            Save proposals ({editable.length})
          </SubmitButton>
        </div>
      )}
    </form>
  );
}

/** student.promote: choose the next session's section for each class students move to, then confirm. */
export function ConfirmForm({ sectionId, targetSessionId, classes }: { sectionId: string; targetSessionId: string; classes: { id: string; name: string; sections: { id: string; label: string }[] }[] }) {
  const [state, action] = useActionState(confirmPromotionsAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="sectionId" value={sectionId} />
      <input type="hidden" name="targetSessionId" value={targetSessionId} />
      {classes.map((c) => (
        <div key={c.id}>
          <input type="hidden" name="targetClass" value={c.id} />
          <SelectField id={`tgt-${c.id}`} label={`Section for ${c.name}`} name={`target:${c.id}`} options={[{ value: "", label: c.sections.length ? "Choose a section" : "No section yet — create one first" }, ...c.sections.map((s) => ({ value: s.id, label: s.label }))]} />
        </div>
      ))}
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <input type="checkbox" name="understood" required className="mt-0.5 size-5 accent-primary" />
        <span>I understand this creates next-session enrollments, ends this session&apos;s enrollments and records leavers. It can&apos;t be undone here.</span>
      </label>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Confirming…">
        Confirm promotions
      </SubmitButton>
    </form>
  );
}
