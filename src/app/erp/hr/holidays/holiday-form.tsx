"use client";

import { useActionState } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createHolidayAction } from "../actions";

const APPLIES = [
  { value: "ALL", label: "Everyone" },
  { value: "STAFF", label: "Staff only" },
  { value: "STUDENTS", label: "Students only" },
];

export function HolidayForm({ min, max }: { min: string; max: string }) {
  const [state, action] = useActionState(createHolidayAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField
          label="Date"
          id="hol-date"
          name="date"
          type="date"
          min={min}
          max={max}
          error={fe.date}
          required
        />
        <TextField
          label="Name"
          id="hol-name"
          name="name"
          maxLength={80}
          placeholder="e.g. Independence Day"
          error={fe.name}
          required
        />
        <SelectField
          label="Applies to"
          id="hol-applies"
          name="appliesTo"
          options={APPLIES}
          defaultValue="ALL"
          hint="Everyone and staff-only holidays are days off for staff."
          error={fe.appliesTo}
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">Add holiday</SubmitButton>
    </form>
  );
}
