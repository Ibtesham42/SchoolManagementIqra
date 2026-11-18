"use client";

import { useActionState } from "react";
import { FormStatus, SelectField, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateEmployeeContactAction, updateEmployeePersonalAction } from "../../../actions";

const GENDER_OPTIONS = [
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "OTHER", label: "Other" },
];

function Ref({ id, version }: { id: string; version: number }) {
  return (
    <>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={version} />
    </>
  );
}

export interface PersonalDefaults {
  firstName: string;
  middleName: string;
  lastName: string;
  dob: string;
  gender: string;
}

export function PersonalForm({ id, version, d, today }: { id: string; version: number; d: PersonalDefaults; today: string }) {
  const [state, action] = useActionState(updateEmployeePersonalAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Ref id={id} version={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="First name" id="p-first" name="firstName" defaultValue={d.firstName} maxLength={60} error={fe.firstName} required autoComplete="off" />
        <TextField label="Middle name (optional)" id="p-middle" name="middleName" defaultValue={d.middleName} maxLength={60} error={fe.middleName} autoComplete="off" />
        <TextField label="Last name (optional)" id="p-last" name="lastName" defaultValue={d.lastName} maxLength={60} error={fe.lastName} autoComplete="off" />
        <TextField label="Date of birth" id="p-dob" name="dob" type="date" min="1940-01-01" max={today} defaultValue={d.dob} error={fe.dob} required />
        <SelectField label="Gender" id="p-gender" name="gender" options={GENDER_OPTIONS} defaultValue={d.gender} error={fe.gender} required />
      </div>
      <SubmitButton className="w-full sm:w-fit">Save personal details</SubmitButton>
    </form>
  );
}

export interface ContactDefaults {
  personalPhone: string;
  workPhone: string;
  personalEmail: string;
  workEmail: string;
  line1: string;
  line2: string;
  city: string;
  district: string;
  state: string;
  pinCode: string;
  country: string;
  ecName: string;
  ecRelation: string;
  ecPhone: string;
}

export function ContactForm({ id, version, d }: { id: string; version: number; d: ContactDefaults }) {
  const [state, action] = useActionState(updateEmployeeContactAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <Ref id={id} version={version} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Personal phone" id="c-pphone" name="personalPhone" type="tel" inputMode="tel" defaultValue={d.personalPhone} error={fe.personalPhone} required autoComplete="off" />
        <TextField label="Work phone (optional)" id="c-wphone" name="workPhone" type="tel" inputMode="tel" defaultValue={d.workPhone} error={fe.workPhone} autoComplete="off" />
        <TextField label="Personal email (optional)" id="c-pemail" name="personalEmail" type="email" defaultValue={d.personalEmail} error={fe.personalEmail} autoComplete="off" />
        <TextField label="Work email (optional)" id="c-wemail" name="workEmail" type="email" defaultValue={d.workEmail} error={fe.workEmail} autoComplete="off" />
      </div>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Home address (optional — clear every field to remove it)</legend>
        <div className="sm:col-span-2">
          <TextField label="Address line 1" id="c-line1" name="line1" defaultValue={d.line1} error={fe["address.line1"]} autoComplete="off" />
        </div>
        <div className="sm:col-span-2">
          <TextField label="Address line 2" id="c-line2" name="line2" defaultValue={d.line2} error={fe["address.line2"]} autoComplete="off" />
        </div>
        <TextField label="City / town" id="c-city" name="city" defaultValue={d.city} error={fe["address.city"]} autoComplete="off" />
        <TextField label="District" id="c-district" name="district" defaultValue={d.district} error={fe["address.district"]} autoComplete="off" />
        <TextField label="State" id="c-state" name="state" defaultValue={d.state} error={fe["address.state"]} autoComplete="off" />
        <TextField label="PIN code" id="c-pin" name="pinCode" inputMode="numeric" maxLength={6} defaultValue={d.pinCode} error={fe["address.pinCode"]} autoComplete="off" />
        <TextField label="Country" id="c-country" name="country" defaultValue={d.country} error={fe["address.country"]} autoComplete="off" />
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold">Emergency contact (optional)</legend>
        <TextField label="Name" id="c-ecname" name="ecName" defaultValue={d.ecName} error={fe["emergencyContact.name"]} autoComplete="off" />
        <TextField label="Relationship" id="c-ecrel" name="ecRelation" defaultValue={d.ecRelation} error={fe["emergencyContact.relation"]} autoComplete="off" />
        <TextField label="Phone" id="c-ecphone" name="ecPhone" type="tel" inputMode="tel" defaultValue={d.ecPhone} error={fe["emergencyContact.phone"]} autoComplete="off" />
      </fieldset>
      <SubmitButton className="w-full sm:w-fit">Save contact details</SubmitButton>
    </form>
  );
}
