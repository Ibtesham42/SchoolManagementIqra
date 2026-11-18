"use client";

import { useActionState } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import {
  createDepartmentAction,
  createDesignationAction,
  updateDepartmentAction,
  updateDesignationAction,
} from "./actions";

export interface MasterDefaults {
  id?: string;
  version?: number;
  code: string;
  name: string;
  staffType?: string;
  /** Once employees use the record, its code (and a designation's staff type) can't change — service rule. */
  locked?: boolean;
}

const STAFF_TYPE_OPTIONS = [
  { value: "", label: "Choose…" },
  { value: "TEACHING", label: "Teaching" },
  { value: "NON_TEACHING", label: "Non-teaching" },
];

/** Create (no id) or edit a department or designation. The service re-checks uniqueness, locks and the version. */
export function MasterForm({
  kind,
  defaults,
  idPrefix = "f",
}: {
  kind: "department" | "designation";
  defaults: MasterDefaults;
  idPrefix?: string;
}) {
  const editing = Boolean(defaults.id);
  const action =
    kind === "department"
      ? editing
        ? updateDepartmentAction
        : createDepartmentAction
      : editing
        ? updateDesignationAction
        : createDesignationAction;
  const [state, formAction] = useActionState(action, initialState);
  const fe = state.fieldErrors ?? {};
  const p = `${idPrefix}-${kind}-${defaults.id ?? "new"}`;
  const label = kind === "department" ? "Department" : "Designation";
  return (
    <form action={formAction} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      {defaults.id && (
        <>
          <input type="hidden" name="id" value={defaults.id} />
          <input type="hidden" name="version" value={defaults.version} />
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={`${label} name`}
          id={`${p}-name`}
          name="name"
          defaultValue={defaults.name}
          placeholder={
            kind === "department" ? "Science" : "Trained Graduate Teacher"
          }
          maxLength={80}
          hint="Any language, e.g. English, Hindi or Khasi."
          error={fe.name}
          required
        />
        {defaults.locked ? (
          <>
            <input type="hidden" name="code" value={defaults.code} />
            <TextField
              label="Code"
              id={`${p}-code`}
              name="code-display"
              defaultValue={defaults.code}
              readOnly
              hint="Fixed: staff records already use it."
            />
          </>
        ) : (
          <TextField
            label="Code"
            id={`${p}-code`}
            name="code"
            defaultValue={defaults.code}
            placeholder={kind === "department" ? "SCI" : "TGT"}
            maxLength={20}
            autoCapitalize="characters"
            hint="English letters and digits, e.g. SCI or ADMIN-OFFICE. Fixed once staff use it."
            error={fe.code}
            required
          />
        )}
        {kind === "designation" &&
          (defaults.locked ? (
            <>
              <input
                type="hidden"
                name="staffType"
                value={defaults.staffType}
              />
              <TextField
                label="Staff type"
                id={`${p}-type`}
                name="staffType-display"
                defaultValue={
                  defaults.staffType === "TEACHING"
                    ? "Teaching"
                    : "Non-teaching"
                }
                readOnly
                hint="Fixed: staff hold this designation."
              />
            </>
          ) : (
            <SelectField
              label="Staff type"
              id={`${p}-type`}
              name="staffType"
              options={STAFF_TYPE_OPTIONS}
              defaultValue={defaults.staffType ?? ""}
              hint="Employees with this designation get this staff type."
              error={fe.staffType}
              required
            />
          ))}
      </div>
      <SubmitButton className="w-full sm:w-fit">
        {editing ? `Save ${kind}` : `Add ${kind}`}
      </SubmitButton>
    </form>
  );
}
