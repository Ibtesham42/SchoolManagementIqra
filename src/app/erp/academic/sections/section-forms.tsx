"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { assignClassTeacherAction, copySectionsAction, createSectionsAction, updateSectionAction } from "../actions";

type Option = { value: string; label: string };

/** "Add sections A–D" (or a single one). All-or-nothing; the service re-checks session and class. */
export function AddSectionsForm({ sessionId, classes, schoolDefaultCapacity }: { sessionId: string; classes: Option[]; schoolDefaultCapacity: number }) {
  const [state, action] = useActionState(createSectionsAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="academicSessionId" value={sessionId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="Class" id="add-class" name="classId" options={[{ value: "", label: "Choose a class" }, ...classes]} defaultValue="" error={fe.classId} required />
        <TextField label="Section names" id="add-names" name="names" defaultValue="A, B, C, D" hint="Separate with commas, e.g. A, B, C or Rose, Lily." error={fe.names ?? fe["names.0"]} required />
        <TextField
          label="Capacity (optional)"
          id="add-capacity"
          name="capacity"
          type="number"
          inputMode="numeric"
          min={1}
          max={200}
          hint={`Empty: the class default, else the school default (${schoolDefaultCapacity}).`}
          error={fe.capacity}
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">Add sections</SubmitButton>
    </form>
  );
}

export function EditSectionForm({ section }: { section: { id: string; version: number; name: string; capacity: number } }) {
  const [state, action] = useActionState(updateSectionAction, initialState);
  const fe = state.fieldErrors ?? {};
  const p = `edit-${section.id}`;
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={section.id} />
      <input type="hidden" name="version" value={section.version} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" id={`${p}-name`} name="name" defaultValue={section.name} maxLength={20} hint="Changing the name also changes the section code." error={fe.name} required />
        <TextField label="Capacity" id={`${p}-capacity`} name="capacity" type="number" inputMode="numeric" min={1} max={200} defaultValue={section.capacity} error={fe.capacity} required />
      </div>
      <SubmitButton className="w-full sm:w-fit">Save section</SubmitButton>
    </form>
  );
}

export function AssignTeacherForm({ section, teachers }: { section: { id: string; version: number; classTeacherId: string | null }; teachers: Option[] }) {
  const [state, action] = useActionState(assignClassTeacherAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={section.id} />
      <input type="hidden" name="version" value={section.version} />
      <SelectField
        label="Class teacher"
        id={`teacher-${section.id}`}
        name="userId"
        options={[{ value: "", label: "Choose a teacher" }, ...teachers]}
        defaultValue={section.classTeacherId ?? ""}
        hint="Active users with the Teacher or Class Teacher role. One section per teacher in a session."
        error={fe.userId}
        required
      />
      <SubmitButton className="w-full sm:w-fit">{section.classTeacherId ? "Change class teacher" : "Assign class teacher"}</SubmitButton>
    </form>
  );
}

export function CopySectionsForm({ toSessionId, sources }: { toSessionId: string; sources: Option[] }) {
  const [state, action] = useActionState(copySectionsAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="toSessionId" value={toSessionId} />
      <SelectField
        label="Copy from session"
        id="copy-from"
        name="fromSessionId"
        options={sources}
        defaultValue={sources[0]?.value}
        hint="Copies active sections of active classes with their capacity. Class teachers are not copied. Sections that already exist here are skipped."
        error={fe.fromSessionId}
      />
      <SubmitButton variant="outline" className="w-full sm:w-fit">Copy sections</SubmitButton>
    </form>
  );
}
