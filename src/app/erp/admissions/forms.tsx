"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState, type ActionState } from "@/lib/action-state";
import { checkFileSize } from "@/lib/storage/upload-limits";
import {
  createDraftAction,
  rejectApplicationAction,
  returnToDraftAction,
  saveContactStepAction,
  saveGuardiansStepAction,
  savePreviousSchoolStepAction,
  saveStudentStepAction,
  setSectionAction,
  submitApplicationAction,
  approveApplicationAction,
} from "./actions";

type Option = { value: string; label: string };
type Ref = { id: string; version: number };

const CHOICE_CLASS = "flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm pointer-fine:min-h-9";

function Hidden({ r }: { r?: Ref }) {
  if (!r) return null;
  return (
    <>
      <input type="hidden" name="id" value={r.id} />
      <input type="hidden" name="version" value={r.version} />
    </>
  );
}

/** Sticky on phones (above the bottom navigation), inline from lg up. */
function StepBar({ back, children }: { back?: string; children: ReactNode }) {
  return (
    <div className="sticky bottom-16 z-10 -mx-4 flex flex-col-reverse gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur sm:flex-row sm:justify-between lg:bottom-0">
      {back ? (
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link href={back}>Back</Link>
        </Button>
      ) : (
        <span />
      )}
      {children}
    </div>
  );
}

// ───────────────────────────── Step 1: student & class ─────────────────────────────

export interface StudentDefaults {
  academicSessionId: string;
  classId: string;
  firstName: string;
  middleName: string;
  lastName: string;
  dob: string;
  gender: string;
}

export function StudentStepForm({ r, defaults, sessions, classes }: { r?: Ref; defaults: StudentDefaults; sessions: Option[]; classes: Option[] }) {
  const [state, action] = useActionState(r ? saveStudentStepAction : createDraftAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Hidden r={r} />
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Admission for</legend>
        <SelectField label="Academic session" name="academicSessionId" options={[{ value: "", label: "Choose a session" }, ...sessions]} defaultValue={defaults.academicSessionId} error={fe.academicSessionId} required />
        <SelectField label="Class applied for" name="classId" options={[{ value: "", label: "Choose a class" }, ...classes]} defaultValue={defaults.classId} error={fe.classId} required />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Student</legend>
        <TextField label="First name" name="firstName" defaultValue={defaults.firstName} autoComplete="off" maxLength={60} error={fe.firstName} required />
        <TextField label="Middle name (optional)" name="middleName" defaultValue={defaults.middleName} autoComplete="off" maxLength={60} error={fe.middleName} />
        <TextField label="Last name (optional)" name="lastName" defaultValue={defaults.lastName} autoComplete="off" maxLength={60} error={fe.lastName} />
        <TextField label="Date of birth" name="dob" type="date" defaultValue={defaults.dob} error={fe.dob} required />
        <SelectField
          label="Gender"
          name="gender"
          options={[{ value: "", label: "Choose" }, { value: "FEMALE", label: "Female" }, { value: "MALE", label: "Male" }, { value: "OTHER", label: "Other" }]}
          defaultValue={defaults.gender}
          error={fe.gender}
          required
        />
      </fieldset>
      <StepBar back={r ? undefined : "/erp/admissions"}>
        <SubmitButton className="w-full sm:w-auto">{r ? "Save & continue" : "Create draft & continue"}</SubmitButton>
      </StepBar>
    </form>
  );
}

// ───────────────────────────── Step 2: parents / guardians ─────────────────────────────

export interface GuardianSlot {
  name: string;
  phone: string;
  altPhone: string;
  email: string;
  occupation: string;
  emergency: boolean;
  relation?: string;
}

const SLOT_TITLES = ["Father", "Mother", "Guardian / other"];

export function GuardiansStepForm({ r, slots, primary, back }: { r: Ref; slots: GuardianSlot[]; primary: string; back: string }) {
  const [state, action] = useActionState(saveGuardiansStepAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Hidden r={r} />
      <p className="text-sm text-muted-foreground">Fill in at least one. Leave a section empty to skip it. Choose one primary contact for school communication.</p>
      {fe.primary && (
        <p role="alert" className="text-sm text-destructive">
          {fe.primary}
        </p>
      )}
      {[0, 1, 2].map((i) => {
        const s = slots[i];
        const e = (f: string) => fe[`g${i}.${f}`];
        return (
          <fieldset key={i} className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2">
            <legend className="px-1 text-sm font-semibold">{SLOT_TITLES[i]}</legend>
            {i === 2 && (
              <SelectField label="Relation" id="g2_relation" name="g2_relation" options={[{ value: "GUARDIAN", label: "Guardian" }, { value: "OTHER", label: "Other relative" }]} defaultValue={s.relation ?? "GUARDIAN"} />
            )}
            <TextField label="Full name" id={`g${i}_name`} name={`g${i}_name`} defaultValue={s.name} autoComplete="off" maxLength={120} error={e("name")} />
            <TextField label="Mobile number" id={`g${i}_phone`} name={`g${i}_phone`} type="tel" inputMode="tel" defaultValue={s.phone} hint="10 digits; +91 optional." error={e("phone")} />
            <TextField label="Alternate number (optional)" id={`g${i}_altPhone`} name={`g${i}_altPhone`} type="tel" inputMode="tel" defaultValue={s.altPhone} error={e("altPhone")} />
            <TextField label="Email (optional)" id={`g${i}_email`} name={`g${i}_email`} type="email" defaultValue={s.email} error={e("email")} />
            <TextField label="Occupation (optional)" id={`g${i}_occupation`} name={`g${i}_occupation`} defaultValue={s.occupation} maxLength={80} error={e("occupation")} />
            <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
              <label className={CHOICE_CLASS}>
                <input type="radio" name="primary" value={String(i)} defaultChecked={primary === String(i)} className="size-4" /> Primary contact
              </label>
              <label className={CHOICE_CLASS}>
                <input type="checkbox" name={`g${i}_emergency`} defaultChecked={s.emergency} className="size-4" /> Emergency contact
              </label>
            </div>
          </fieldset>
        );
      })}
      <StepBar back={back}>
        <SubmitButton className="w-full sm:w-auto">Save & continue</SubmitButton>
      </StepBar>
    </form>
  );
}

// ───────────────────────────── Step 3: contact & address ─────────────────────────────

export interface ContactDefaults {
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

export function ContactStepForm({ r, defaults, back }: { r: Ref; defaults: ContactDefaults; back: string }) {
  const [state, action] = useActionState(saveContactStepAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Hidden r={r} />
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Student contact (optional)</legend>
        <TextField label="Student's phone" name="phone" type="tel" inputMode="tel" defaultValue={defaults.phone} error={fe.phone} />
        <TextField label="Student's email" name="email" type="email" defaultValue={defaults.email} error={fe.email} />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Home address</legend>
        <div className="sm:col-span-2">
          <TextField label="Address line 1" name="line1" defaultValue={defaults.line1} autoComplete="address-line1" error={fe["address.line1"]} required />
        </div>
        <div className="sm:col-span-2">
          <TextField label="Address line 2 (optional)" name="line2" defaultValue={defaults.line2} autoComplete="address-line2" error={fe["address.line2"]} />
        </div>
        <TextField label="City / town" name="city" defaultValue={defaults.city} autoComplete="address-level2" error={fe["address.city"]} required />
        <TextField label="District (optional)" name="district" defaultValue={defaults.district} error={fe["address.district"]} />
        <TextField label="State" name="state" defaultValue={defaults.state} autoComplete="address-level1" error={fe["address.state"]} required />
        <TextField label="PIN code" name="pinCode" inputMode="numeric" maxLength={6} defaultValue={defaults.pinCode} autoComplete="postal-code" error={fe["address.pinCode"]} required />
        <TextField label="Country" name="country" defaultValue={defaults.country} error={fe["address.country"]} />
      </fieldset>
      <StepBar back={back}>
        <SubmitButton className="w-full sm:w-auto">Save & continue</SubmitButton>
      </StepBar>
    </form>
  );
}

// ───────────────────────────── Step 4: previous school ─────────────────────────────

export interface PreviousSchoolDefaults {
  schoolName: string;
  board: string;
  lastClass: string;
  yearLeft: string;
  tcNumber: string;
}

export function PreviousSchoolForm({ r, defaults, back }: { r: Ref; defaults: PreviousSchoolDefaults; back: string }) {
  const [state, action] = useActionState(savePreviousSchoolStepAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Hidden r={r} />
      <p className="text-sm text-muted-foreground">Leave empty for a first admission (no previous school).</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField label="Previous school name" name="schoolName" defaultValue={defaults.schoolName} maxLength={150} error={fe["previousSchool.name"]} />
        </div>
        <TextField label="Board (optional)" name="board" defaultValue={defaults.board} placeholder="CBSE, ICSE, State board…" maxLength={60} error={fe["previousSchool.board"]} />
        <TextField label="Last class attended" name="lastClass" defaultValue={defaults.lastClass} maxLength={40} error={fe["previousSchool.lastClass"]} />
        <TextField label="Year left" name="yearLeft" inputMode="numeric" maxLength={4} defaultValue={defaults.yearLeft} error={fe["previousSchool.yearLeft"]} />
        <TextField label="Transfer certificate number" name="tcNumber" defaultValue={defaults.tcNumber} maxLength={40} error={fe["previousSchool.tcNumber"]} />
      </div>
      <StepBar back={back}>
        <SubmitButton className="w-full sm:w-auto">Save & continue</SubmitButton>
      </StepBar>
    </form>
  );
}

// ───────────────────────────── Step 5: submit ─────────────────────────────

export function SubmitApplicationForm({ r, back, disabled }: { r: Ref; back: string; disabled: boolean }) {
  const [state, action] = useActionState(submitApplicationAction, initialState);
  return (
    <form action={action} className="grid gap-4">
      <FormStatus state={state} />
      <Hidden r={r} />
      <StepBar back={back}>
        <SubmitButton className="w-full sm:w-auto" disabled={disabled}>
          Submit application
        </SubmitButton>
      </StepBar>
    </form>
  );
}

// ───────────────────────────── Review actions ─────────────────────────────

export function SectionForm({ r, sections, current }: { r: Ref; sections: Option[]; current: string }) {
  const [state, action] = useActionState(setSectionAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <FormStatus state={state} />
      <Hidden r={r} />
      <SelectField label="Section on approval" name="sectionId" options={[{ value: "", label: "Choose a section" }, ...sections]} defaultValue={current} error={state.fieldErrors?.sectionId} required />
      <SubmitButton variant="outline" className="w-full sm:w-fit">
        Save section
      </SubmitButton>
    </form>
  );
}

const TEXTAREA_CLASS = "min-h-24 w-full rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm";

export function ReasonForm({ r, kind }: { r: Ref; kind: "return" | "reject" }) {
  const [state, action] = useActionState<ActionState, FormData>(kind === "reject" ? rejectApplicationAction : returnToDraftAction, initialState);
  const fid = `${kind}-reason`;
  const err = state.fieldErrors?.reason;
  return (
    <form action={action} className="grid gap-3">
      <FormStatus state={state} />
      <Hidden r={r} />
      <div className="grid gap-1.5">
        <label htmlFor={fid} className="text-sm font-medium">
          {kind === "reject" ? "Reason for rejection" : "What needs to be corrected"}
        </label>
        <textarea id={fid} name="reason" maxLength={500} required aria-invalid={err ? true : undefined} aria-describedby={err ? `${fid}-error` : undefined} className={TEXTAREA_CLASS} />
        {err && (
          <p id={`${fid}-error`} className="text-sm text-destructive">
            {err}
          </p>
        )}
      </div>
      <SubmitButton variant={kind === "reject" ? "destructive" : "outline"} className="w-full sm:w-fit">
        {kind === "reject" ? "Reject application" : "Return to draft"}
      </SubmitButton>
    </form>
  );
}

// ───────────────────────────── Documents (upload route, KI-048) ─────────────────────────────

/**
 * A plain multipart form posted to the dedicated upload route (never a server action: 10 MB files).
 * Works without JavaScript (the route answers with a 303 back here); with JavaScript the size is
 * checked first so a too-large file is never sent. The server re-checks everything.
 */
export function UploadDocumentForm({ applicationId, from, types, maxBytes }: { applicationId: string; from: "edit" | "detail"; types: Option[]; maxBytes: number }) {
  const [error, setError] = useState<string | null>(null);
  const p = `upload-${from}`;
  return (
    <form
      method="post"
      action={`/api/v1/admissions/${applicationId}/documents`}
      encType="multipart/form-data"
      className="grid gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement | null;
        const message = checkFileSize(input?.files?.[0], maxBytes);
        setError(message);
        if (message) e.preventDefault();
      }}
    >
      <input type="hidden" name="from" value={from} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="Document type" id={`${p}-type`} name="type" options={types} defaultValue={types[0]?.value} required />
        <TextField label="Description (needed for “Other”)" id={`${p}-label`} name="label" maxLength={80} placeholder="e.g. Caste certificate" />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor={`${p}-file`} className="text-sm font-medium">
          File
        </label>
        <input
          id={`${p}-file`}
          name="file"
          type="file"
          required
          accept="application/pdf,image/jpeg,image/png"
          aria-describedby={`${p}-hint${error ? ` ${p}-error` : ""}`}
          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1"
        />
        <p id={`${p}-hint`} className="text-xs text-muted-foreground">
          PDF, JPEG or PNG, up to {Math.round(maxBytes / 1024 / 1024)} MB. Photos are cropped to a square and all hidden data (such as location) is removed.
        </p>
        {error && (
          <p id={`${p}-error`} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full sm:w-fit">
        Upload
      </Button>
    </form>
  );
}

// ───────────────────────────── Approve = register (D1, D9) ─────────────────────────────

export interface ApprovalGuardian {
  id: string;
  label: string;
  matches: { id: string; name: string; students: string[] }[];
}

/**
 * Admission date, an EXPLICIT choice per guardian ("create new" by default — never an automatic link) and,
 * when duplicates were found, the mandatory reason. The service re-checks everything under lock.
 */
export function ApproveForm({ r, today, guardians, needsOverride, sectionLabel }: { r: Ref; today: string; guardians: ApprovalGuardian[]; needsOverride: boolean; sectionLabel: string }) {
  const [state, action] = useActionState(approveApplicationAction, initialState);
  const fe = state.fieldErrors ?? {};
  if (state.ok) return <FormStatus state={state} />;
  return (
    <form action={action} className="grid gap-4">
      <FormStatus state={state} />
      <Hidden r={r} />
      <p className="text-sm">
        The student is registered in section <span className="font-medium">{sectionLabel}</span> and gets a permanent student ID and admission number. This can&apos;t be undone.
      </p>
      <div className="sm:w-60">
        <TextField label="Admission date" name="admissionDate" type="date" defaultValue={today} error={fe.admissionDate} required />
      </div>
      {guardians.map((g) => (
        <fieldset key={g.id} className="grid gap-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-semibold">{g.label}</legend>
          {g.matches.length === 0 ? (
            <>
              <input type="hidden" name={`link_${g.id}`} value="new" />
              <p className="text-sm text-muted-foreground">No existing guardian has this phone number. A new guardian record is created.</p>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">An existing guardian has the same phone number. Link only if it is the same person (siblings).</p>
              <label className={CHOICE_CLASS}>
                <input type="radio" name={`link_${g.id}`} value="new" defaultChecked className="size-4" /> Create a new guardian record
              </label>
              {g.matches.map((m) => (
                <label key={m.id} className={`${CHOICE_CLASS} h-auto py-2`}>
                  <input type="radio" name={`link_${g.id}`} value={m.id} className="size-4 shrink-0" />
                  <span>
                    Link to <span className="font-medium">{m.name}</span>
                    {m.students.length ? <span className="block text-xs text-muted-foreground">Parent of {m.students.join(", ")}</span> : null}
                  </span>
                </label>
              ))}
            </>
          )}
        </fieldset>
      ))}
      {fe.guardianLinks && (
        <p role="alert" className="text-sm text-destructive">
          {fe.guardianLinks}
        </p>
      )}
      {needsOverride && (
        <div className="grid gap-1.5">
          <label htmlFor="duplicateOverride" className="text-sm font-medium">
            Reason for approving despite the possible duplicate
          </label>
          <textarea id="duplicateOverride" name="duplicateOverride" maxLength={500} required className={TEXTAREA_CLASS} aria-invalid={fe.duplicateOverride ? true : undefined} />
          {fe.duplicateOverride && <p className="text-sm text-destructive">{fe.duplicateOverride}</p>}
        </div>
      )}
      {!needsOverride && <input type="hidden" name="duplicateOverride" value="" />}
      <SubmitButton className="w-full sm:w-fit" pendingLabel="Registering…">
        Approve & register student
      </SubmitButton>
    </form>
  );
}
