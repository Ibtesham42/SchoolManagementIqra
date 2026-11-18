"use client";

import { useActionState, useState } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { applyForLeaveAction, decideLeaveAction } from "./actions";

const TEXTAREA =
  "min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm";

function Reason({
  id,
  name,
  label,
  error,
  required,
  hint,
}: {
  id: string;
  name: string;
  label: string;
  error?: string;
  required?: boolean;
  hint?: string;
}) {
  const describedBy =
    [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        name={name}
        maxLength={500}
        rows={3}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={TEXTAREA}
      />
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export interface ApplyType {
  id: string;
  label: string;
  allowHalfDay: boolean;
}

/** Apply for own leave. Days are counted by the server (weekly off and holidays excluded). */
export function ApplyLeaveForm({
  types,
  min,
  max,
}: {
  types: ApplyType[];
  min: string;
  max: string;
}) {
  const [state, action] = useActionState(applyForLeaveAction, initialState);
  const [typeId, setTypeId] = useState(types[0]?.id ?? "");
  const [half, setHalf] = useState("");
  const fe = state.fieldErrors ?? {};
  const halfAllowed = types.find((t) => t.id === typeId)?.allowHalfDay ?? false;
  const halfDay = halfAllowed ? half : "";
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <SelectField
        label="Leave type"
        id="lv-type"
        name="leaveTypeId"
        options={types.map((t) => ({ value: t.id, label: t.label }))}
        value={typeId}
        onChange={(e) => setTypeId(e.target.value)}
        error={fe.leaveTypeId}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="First day"
          id="lv-from"
          name="fromDate"
          type="date"
          min={min}
          max={max}
          error={fe.fromDate}
          required
        />
        {halfDay === "" && (
          <TextField
            label="Last day"
            id="lv-to"
            name="toDate"
            type="date"
            min={min}
            max={max}
            hint="Same as the first day for a single day."
            error={fe.toDate}
          />
        )}
      </div>
      {halfAllowed && (
        <SelectField
          label="Half day?"
          id="lv-half"
          name="halfDay"
          value={halfDay}
          onChange={(e) => setHalf(e.target.value)}
          options={[
            { value: "", label: "No — full day(s)" },
            { value: "FIRST", label: "Yes — first half" },
            { value: "SECOND", label: "Yes — second half" },
          ]}
          error={fe.halfDay}
        />
      )}
      <Reason
        id="lv-reason"
        name="reason"
        label="Reason"
        required
        error={fe.reason}
        hint="Seen by you and the approvers only."
      />
      <SubmitButton className="w-full sm:w-fit">Send request</SubmitButton>
    </form>
  );
}

/** Approve or reject one request. A rejection needs a note (the employee sees it). */
export function DecideLeaveForm({
  id,
  version,
  idPrefix,
}: {
  id: string;
  version: number;
  idPrefix: string;
}) {
  const [state, action] = useActionState(decideLeaveAction, initialState);
  const fe = state.fieldErrors ?? {};
  const p = `${idPrefix}-${id}`;
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <Reason
        id={`${p}-note`}
        name="note"
        label="Note to the employee"
        hint="Optional when approving; required when rejecting."
        error={fe.note}
      />
      <div className="grid gap-2 sm:flex">
        <SubmitButton
          name="decision"
          value="APPROVE"
          className="w-full sm:w-fit"
        >
          Approve
        </SubmitButton>
        <SubmitButton
          name="decision"
          value="REJECT"
          variant="destructive"
          className="w-full sm:w-fit"
        >
          Reject
        </SubmitButton>
      </div>
    </form>
  );
}
