"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { addExamSubjectsAction, createExamAction, updateExamAction, updateExamSubjectAction } from "../actions";

/** Create (academicSessionId) or edit (id + version) an exam. The scale can only change while it's a draft. */
export function ExamForm({
  defaults,
  scales,
  scaleLocked = false,
}: {
  defaults: { id?: string; version?: number; academicSessionId?: string; name: string; gradeScaleId: string; startDate: string; endDate: string };
  scales: { id: string; name: string }[];
  scaleLocked?: boolean;
}) {
  const editing = Boolean(defaults.id);
  const [state, action] = useActionState(editing ? updateExamAction : createExamAction, initialState);
  const id = (f: string) => `ex-${defaults.id ?? "new"}-${f}`;
  return (
    <form action={action} className="grid gap-3">
      {editing ? (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={String(defaults.version)} />
        </>
      ) : (
        <input type="hidden" name="academicSessionId" value={defaults.academicSessionId} />
      )}
      <TextField id={id("name")} label="Exam name" name="name" defaultValue={defaults.name} maxLength={80} required placeholder={editing ? undefined : "e.g. Half-yearly"} error={state.fieldErrors?.name} />
      {scaleLocked ? (
        <>
          <input type="hidden" name="gradeScaleId" value={defaults.gradeScaleId} />
          <p className="text-sm text-muted-foreground">The grading scale is fixed once the exam is scheduled.</p>
        </>
      ) : (
        <SelectField
          id={id("scale")}
          label="Grading scale"
          name="gradeScaleId"
          defaultValue={defaults.gradeScaleId}
          options={[{ value: "", label: "Choose a scale" }, ...scales.map((s) => ({ value: s.id, label: s.name }))]}
          error={state.fieldErrors?.gradeScaleId}
          required
        />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={id("start")} label="Starts on (optional)" name="startDate" type="date" defaultValue={defaults.startDate} error={state.fieldErrors?.startDate} />
        <TextField id={id("end")} label="Ends on (optional)" name="endDate" type="date" defaultValue={defaults.endDate} error={state.fieldErrors?.endDate} />
      </div>
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        {editing ? "Save exam" : "Create exam"}
      </SubmitButton>
    </form>
  );
}

function MaximaFields({ prefix, defaults, errors }: { prefix: string; defaults: { examDate: string; maxTheory: string; maxPractical: string; maxInternal: string; passPercent: string }; errors?: Record<string, string> }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-2">
        <TextField id={`${prefix}-th`} label="Theory max" name="maxTheory" inputMode="numeric" placeholder="0" defaultValue={defaults.maxTheory} maxLength={4} error={errors?.maxTheory} />
        <TextField id={`${prefix}-pr`} label="Practical max" name="maxPractical" inputMode="numeric" placeholder="0" defaultValue={defaults.maxPractical} maxLength={4} error={errors?.maxPractical} />
        <TextField id={`${prefix}-in`} label="Internal max" name="maxInternal" inputMode="numeric" placeholder="0" defaultValue={defaults.maxInternal} maxLength={4} error={errors?.maxInternal} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id={`${prefix}-pass`} label="Pass mark % (optional)" name="passPercent" inputMode="decimal" defaultValue={defaults.passPercent} maxLength={6} hint="Leave blank for no pass mark." error={errors?.passPercent} />
        <TextField id={`${prefix}-date`} label="Exam date (optional)" name="examDate" type="date" defaultValue={defaults.examDate} error={errors?.examDate} />
      </div>
    </>
  );
}

/** Adds several class subjects at once with the same maxima (edit individual subjects afterwards). */
export function AddExamSubjectsForm({ examinationId, version, options }: { examinationId: string; version: number; options: { id: string; label: string }[] }) {
  const [state, action] = useActionState(addExamSubjectsAction, initialState);
  if (options.length === 0) return <p className="text-sm text-muted-foreground">Every scholastic class subject of this session is already in the exam (or none are set up yet).</p>;
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="examinationId" value={examinationId} />
      <input type="hidden" name="version" value={String(version)} />
      <fieldset className="grid gap-2" aria-describedby={state.fieldErrors?.classSubjectIds ? "aes-error" : undefined}>
        <legend className="text-sm font-medium">Subjects to add</legend>
        <div className="grid max-h-72 gap-1 overflow-y-auto rounded-lg border p-2 sm:grid-cols-2">
          {options.map((o) => (
            <label key={o.id} className="flex min-h-11 items-center gap-3 rounded-md px-2 text-sm hover:bg-muted pointer-fine:min-h-9">
              <input type="checkbox" name="classSubjectId" value={o.id} className="size-5 accent-primary" />
              {o.label}
            </label>
          ))}
        </div>
        {state.fieldErrors?.classSubjectIds && (
          <p id="aes-error" className="text-sm text-destructive">
            {state.fieldErrors.classSubjectIds}
          </p>
        )}
      </fieldset>
      <MaximaFields prefix="aes" defaults={{ examDate: "", maxTheory: "", maxPractical: "", maxInternal: "", passPercent: "" }} errors={state.fieldErrors} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Adding…">
        Add subjects
      </SubmitButton>
    </form>
  );
}

export function ExamSubjectForm({ defaults }: { defaults: { id: string; version: number; examDate: string; maxTheory: string; maxPractical: string; maxInternal: string; passPercent: string } }) {
  const [state, action] = useActionState(updateExamSubjectAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="id" value={defaults.id} />
      <input type="hidden" name="version" value={String(defaults.version)} />
      <MaximaFields prefix={`es-${defaults.id}`} defaults={defaults} errors={state.fieldErrors} />
      <FormStatus state={state} />
      <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Saving…">
        Save subject
      </SubmitButton>
    </form>
  );
}
