"use client";

import { useActionState } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { createLeaveTypeAction, updateLeaveTypeAction } from "../actions";

export interface LeaveTypeDefaults {
  id?: string;
  version?: number;
  code: string;
  name: string;
  isPaid: boolean;
  annualQuota: string;
  allowHalfDay: boolean;
  carryForwardMax: string;
  appliesTo: string;
  /** In use (balances or requests): code, paid/unpaid and applies-to are fixed — service rule. */
  locked?: boolean;
}

const APPLIES = [
  { value: "ALL", label: "All staff" },
  { value: "TEACHING", label: "Teaching staff" },
  { value: "NON_TEACHING", label: "Non-teaching staff" },
];

function Check({
  id,
  name,
  label,
  defaultChecked,
  disabled,
}: {
  id: string;
  name: string;
  label: string;
  defaultChecked: boolean;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex min-h-11 items-center gap-3 text-sm">
      <input
        id={id}
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="size-5"
      />
      {label}
    </label>
  );
}

/** Create or edit a school-defined leave type (L2). Nothing is pre-filled from assumptions about the school. */
export function LeaveTypeForm({
  d,
  idPrefix = "lt",
}: {
  d: LeaveTypeDefaults;
  idPrefix?: string;
}) {
  const editing = Boolean(d.id);
  const [state, action] = useActionState(
    editing ? updateLeaveTypeAction : createLeaveTypeAction,
    initialState,
  );
  const fe = state.fieldErrors ?? {};
  const p = `${idPrefix}-${d.id ?? "new"}`;
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      {d.id && (
        <>
          <input type="hidden" name="id" value={d.id} />
          <input type="hidden" name="version" value={d.version} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          id={`${p}-name`}
          name="name"
          defaultValue={d.name}
          maxLength={80}
          placeholder="e.g. Casual leave"
          hint="Any language."
          error={fe.name}
          required
        />
        {d.locked ? (
          <>
            <input type="hidden" name="code" value={d.code} />
            <TextField
              label="Code"
              id={`${p}-code`}
              name="code-display"
              defaultValue={d.code}
              readOnly
              hint="Fixed: the type is in use."
            />
          </>
        ) : (
          <TextField
            label="Code"
            id={`${p}-code`}
            name="code"
            defaultValue={d.code}
            maxLength={20}
            autoCapitalize="characters"
            placeholder="e.g. CL"
            error={fe.code}
            required
          />
        )}
        <TextField
          label="Days per academic session (optional)"
          id={`${p}-quota`}
          name="annualQuota"
          inputMode="decimal"
          defaultValue={d.annualQuota}
          hint="Whole or half days. Empty = no quota (e.g. unpaid leave)."
          error={fe.annualQuota}
        />
        <TextField
          label="Carry forward up to (days)"
          id={`${p}-carry`}
          name="carryForwardMax"
          inputMode="decimal"
          defaultValue={d.carryForwardMax}
          hint="0 = nothing carries forward. Unpaid leave never carries forward."
          error={fe.carryForwardMax}
        />
        {d.locked ? (
          <>
            <input type="hidden" name="appliesTo" value={d.appliesTo} />
            {d.isPaid && <input type="hidden" name="isPaid" value="on" />}
          </>
        ) : (
          <SelectField
            label="Who can use it"
            id={`${p}-applies`}
            name="appliesTo"
            options={APPLIES}
            defaultValue={d.appliesTo}
            error={fe.appliesTo}
          />
        )}
        <div className="grid content-start gap-1">
          {!d.locked && (
            <Check
              id={`${p}-paid`}
              name="isPaid"
              label="Paid leave"
              defaultChecked={d.isPaid}
            />
          )}
          <Check
            id={`${p}-half`}
            name="allowHalfDay"
            label="Half days allowed"
            defaultChecked={d.allowHalfDay}
          />
        </div>
      </div>
      <SubmitButton className="w-full sm:w-fit">
        {editing ? "Save leave type" : "Add leave type"}
      </SubmitButton>
    </form>
  );
}
