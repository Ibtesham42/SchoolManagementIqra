"use client";

import Link from "next/link";
import { useActionState, type ReactNode } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { changeStatusAction, updateGuardianAction, updateStudentAction } from "./actions";

/** Student-record forms (slice S7). Single column on phones, 44 px targets, work without JavaScript. */

const GENDER_OPTIONS = [
  { value: "MALE", label: "Male" },
  { value: "FEMALE", label: "Female" },
  { value: "OTHER", label: "Other" },
];

function ActionBar({ cancel, children }: { cancel: string; children: ReactNode }) {
  return (
    <div className="sticky bottom-16 z-10 -mx-4 flex flex-col-reverse gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:justify-between lg:bottom-0">
      <Button asChild variant="outline" className="w-full sm:w-auto">
        <Link href={cancel}>Cancel</Link>
      </Button>
      {children}
    </div>
  );
}

export interface StudentEditDefaults {
  id: string;
  version: number;
  firstName: string;
  middleName: string;
  lastName: string;
  dob: string;
  gender: string;
  phone: string;
  email: string;
  line1: string;
  line2: string;
  city: string;
  district: string;
  state: string;
  pinCode: string;
  country: string;
}

/** `identity` = the caller may edit names, date of birth and gender (ALL scope); otherwise contact only. */
export function StudentEditForm({ d, identity }: { d: StudentEditDefaults; identity: boolean }) {
  const [state, action] = useActionState(updateStudentAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={d.id} />
      <input type="hidden" name="version" value={d.version} />
      {identity && (
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">Student</legend>
          <TextField label="First name" name="firstName" defaultValue={d.firstName} error={fe.firstName} required autoComplete="off" />
          <TextField label="Middle name (optional)" name="middleName" defaultValue={d.middleName} error={fe.middleName} autoComplete="off" />
          <TextField label="Last name (optional)" name="lastName" defaultValue={d.lastName} error={fe.lastName} autoComplete="off" />
          <TextField label="Date of birth" name="dob" type="date" defaultValue={d.dob} error={fe.dob} required />
          <SelectField label="Gender" name="gender" options={GENDER_OPTIONS} defaultValue={d.gender} error={fe.gender} />
        </fieldset>
      )}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Student contact (optional)</legend>
        <TextField label="Student's phone" name="phone" type="tel" inputMode="tel" defaultValue={d.phone} error={fe.phone} autoComplete="off" />
        <TextField label="Student's email" name="email" type="email" defaultValue={d.email} error={fe.email} autoComplete="off" />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Home address</legend>
        <div className="sm:col-span-2">
          <TextField label="Address line 1" name="line1" defaultValue={d.line1} error={fe["address.line1"]} required autoComplete="off" />
        </div>
        <div className="sm:col-span-2">
          <TextField label="Address line 2 (optional)" name="line2" defaultValue={d.line2} error={fe["address.line2"]} autoComplete="off" />
        </div>
        <TextField label="City / town" name="city" defaultValue={d.city} error={fe["address.city"]} required autoComplete="off" />
        <TextField label="District (optional)" name="district" defaultValue={d.district} error={fe["address.district"]} autoComplete="off" />
        <TextField label="State" name="state" defaultValue={d.state} error={fe["address.state"]} required autoComplete="off" />
        <TextField label="PIN code" name="pinCode" inputMode="numeric" maxLength={6} defaultValue={d.pinCode} error={fe["address.pinCode"]} required autoComplete="off" />
        <TextField label="Country" name="country" defaultValue={d.country} error={fe["address.country"]} autoComplete="off" />
      </fieldset>
      <p className="text-sm text-muted-foreground">The student ID and admission number are permanent and can&apos;t be changed.</p>
      <ActionBar cancel={`/erp/students/${d.id}`}>
        <SubmitButton className="w-full sm:w-auto">Save changes</SubmitButton>
      </ActionBar>
    </form>
  );
}

export interface GuardianEditDefaults {
  studentId: string;
  guardianId: string;
  relationLabel: string;
  name: string;
  occupation: string;
  phone: string;
  altPhone: string;
  email: string;
  /** Other students linked to the same guardian (siblings). */
  sharedWith: number;
}

export function GuardianEditForm({ d, identity }: { d: GuardianEditDefaults; identity: boolean }) {
  const [state, action] = useActionState(updateGuardianAction, initialState);
  const fe = state.fieldErrors ?? {};
  const fid = (n: string) => `${d.guardianId}-${n}`; // several guardian forms on one page
  return (
    <form action={action} className="grid gap-4 rounded-lg border p-3" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="studentId" value={d.studentId} />
      <input type="hidden" name="guardianId" value={d.guardianId} />
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">
          {d.relationLabel}
          {identity ? "" : ` — ${d.name}`}
        </legend>
        {identity && <TextField id={fid("name")} label="Name" name="name" defaultValue={d.name} error={fe.name} required autoComplete="off" />}
        {identity && <TextField id={fid("occupation")} label="Occupation (optional)" name="occupation" defaultValue={d.occupation} error={fe.occupation} autoComplete="off" />}
        <TextField id={fid("phone")} label="Phone" name="phone" type="tel" inputMode="tel" defaultValue={d.phone} error={fe.phone} required autoComplete="off" />
        <TextField id={fid("altPhone")} label="Other phone (optional)" name="altPhone" type="tel" inputMode="tel" defaultValue={d.altPhone} error={fe.altPhone} autoComplete="off" />
        <TextField id={fid("email")} label="Email (optional)" name="email" type="email" defaultValue={d.email} error={fe.email} autoComplete="off" />
      </fieldset>
      {d.sharedWith > 0 && (
        <p className="text-sm text-muted-foreground">
          This guardian is also linked to {d.sharedWith} other student{d.sharedWith === 1 ? "" : "s"} (siblings). Changes apply to all of them.
          {!identity && " If any of them is outside your section, only a School Admin can change these details."}
        </p>
      )}
      <SubmitButton variant="outline" className="w-full sm:w-auto sm:justify-self-end">
        Save guardian
      </SubmitButton>
    </form>
  );
}

export function StatusChangeForm({ id, version, today, earliest }: { id: string; version: number; today: string; earliest: string }) {
  const [state, action] = useActionState(changeStatusAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
      <SelectField
        label="What happened"
        name="toStatus"
        options={[
          { value: "", label: "Choose…" },
          { value: "TRANSFERRED", label: "Transferred to another school" },
          { value: "WITHDRAWN", label: "Withdrawn" },
          { value: "GRADUATED", label: "Graduated (completed school)" },
        ]}
        defaultValue=""
        error={fe.toStatus}
        required
      />
      <TextField label="Leaving date" name="effectiveDate" type="date" min={earliest} max={today} defaultValue={today} error={fe.effectiveDate} required />
      <TextField label="Reason" name="reason" error={fe.reason} hint="Shown in the student's status history." required maxLength={500} autoComplete="off" />
      <p className="text-sm text-muted-foreground">
        The student leaves their current class on this date. Their roll number is kept and never reused; the student record and its history stay.
      </p>
      <ActionBar cancel={`/erp/students/${id}`}>
        <SubmitButton variant="destructive" className="w-full sm:w-auto">
          Record leaving
        </SubmitButton>
      </ActionBar>
    </form>
  );
}
