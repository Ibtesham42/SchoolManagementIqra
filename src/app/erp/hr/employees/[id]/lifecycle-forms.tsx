"use client";

import { useActionState, useState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { changeEmploymentAction, changeReportingAction, changeStatusAction } from "../../actions";

interface Option {
  value: string;
  label: string;
}

function Ref({ id, version }: { id: string; version: number }) {
  return (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
    </>
  );
}

function Remarks({ id, error, label = "Remarks (optional)", required = false, name = "remarks" }: { id: string; error?: string; label?: string; required?: boolean; name?: string }) {
  return (
    <div className="grid gap-1.5 sm:col-span-2">
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
        aria-describedby={error ? `${id}-error` : undefined}
        className="min-h-11 rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm"
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function EmploymentForm({
  id,
  version,
  today,
  d,
  departments,
  designations,
  appointmentTypes,
}: {
  id: string;
  version: number;
  today: string;
  d: { departmentId: string; designationId: string; appointmentType: string; confirmationDate: string };
  departments: Option[];
  designations: Option[];
  appointmentTypes: Option[];
}) {
  const [state, action] = useActionState(changeEmploymentAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Ref id={id} version={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Department" id="em-dept" name="departmentId" options={departments} defaultValue={d.departmentId} error={fe.departmentId} required />
        <SelectField label="Designation" id="em-desig" name="designationId" options={designations} defaultValue={d.designationId} hint="Same staff type only (teaching or non-teaching)." error={fe.designationId} required />
        <SelectField label="Appointment type" id="em-appt" name="appointmentType" options={appointmentTypes} defaultValue={d.appointmentType} error={fe.appointmentType} required />
        <TextField label="Confirmation date" id="em-conf" name="confirmationDate" type="date" max={today} defaultValue={d.confirmationDate} hint="Can be corrected, not removed." error={fe.confirmationDate} />
        <TextField label="Effective from" id="em-eff" name="effectiveDate" type="date" defaultValue={today} hint="For the service history." error={fe.effectiveDate} required />
        <Remarks id="em-remarks" error={fe.remarks} />
      </div>
      <SubmitButton className="w-full sm:w-fit">Save employment changes</SubmitButton>
    </form>
  );
}

export function ReportingForm({ id, version, today, current, managers }: { id: string; version: number; today: string; current: string; managers: Option[] }) {
  const [state, action] = useActionState(changeReportingAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Ref id={id} version={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="Reports to" id="rp-mgr" name="reportsToId" options={[{ value: "", label: "Nobody" }, ...managers]} defaultValue={current} hint="Current staff only. Reporting loops are refused." error={fe.reportsToId} />
        <TextField label="Effective from" id="rp-eff" name="effectiveDate" type="date" defaultValue={today} error={fe.effectiveDate} required />
        <Remarks id="rp-remarks" error={fe.remarks} />
      </div>
      <SubmitButton className="w-full sm:w-fit">Save reporting line</SubmitButton>
    </form>
  );
}

export function StatusForm({ id, version, today, actions, canDeactivate }: { id: string; version: number; today: string; actions: Option[]; canDeactivate: boolean }) {
  const [state, action] = useActionState(changeStatusAction, initialState);
  const [chosen, setChosen] = useState("");
  const fe = state.fieldErrors ?? {};
  const leaving = ["RESIGN", "TERMINATE", "RETIRE"].includes(chosen);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Ref id={id} version={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="What happened" id="st-action" name="action" options={[{ value: "", label: "Choose…" }, ...actions]} value={chosen} onChange={(e) => setChosen(e.target.value)} error={fe.action} required />
        <TextField label="Date" id="st-date" name="effectiveDate" type="date" max={today} defaultValue={today} error={fe.effectiveDate} required />
        <Remarks id="st-reason" name="reason" label="Reason" required error={fe.reason} />
      </div>
      {leaving && (
        <div className="grid gap-2 rounded-lg border p-3 text-sm">
          <p>Leaving releases any class-teacher sections of this employee&apos;s login account. The record and its history are kept; the employee ID never changes.</p>
          {canDeactivate ? (
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name="deactivateAccount" className="size-5" />
              <span>Yes, also deactivate the linked login account now (it is signed out everywhere and can no longer sign in)</span>
            </label>
          ) : (
            <p className="text-muted-foreground">If this person has a login account, an administrator who manages users must deactivate it afterwards.</p>
          )}
          {fe.deactivateAccount && <p className="text-destructive">{fe.deactivateAccount}</p>}
        </div>
      )}
      <SubmitButton className="w-full sm:w-fit">Save status</SubmitButton>
    </form>
  );
}
