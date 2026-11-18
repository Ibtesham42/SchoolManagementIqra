"use client";

import { useActionState } from "react";
import { Label } from "@/components/ui/label";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { DATE_FORMATS, LOCALES } from "@/modules/settings/settings.schemas";
import { updateProfileAction } from "./actions";

export interface ProfileDefaults {
  name: string;
  shortCode: string;
  affiliationNo: string;
  board: string;
  email: string;
  website: string;
  phones: string[];
  line1: string;
  line2: string;
  city: string;
  district: string;
  state: string;
  pinCode: string;
  country: string;
  timezone: string;
  locale: string;
  currency: string;
  dateFormat: string;
  opensAt: string;
  closesAt: string;
  officeHours: string;
}

export function ProfileForm({ defaults, timeZones }: { defaults: ProfileDefaults; timeZones: string[] }) {
  const [state, action] = useActionState(updateProfileAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-6" noValidate>
      <FormStatus state={state} />

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Identity</legend>
        <div className="sm:col-span-2">
          <TextField label="School name" name="name" defaultValue={defaults.name} error={fe.name} required />
        </div>
        <TextField label="Short code" name="shortCode" defaultValue={defaults.shortCode} hint="Used in IDs, e.g. JNV-2026-0001." autoCapitalize="characters" error={fe.shortCode} required />
        <TextField label="Board" name="board" defaultValue={defaults.board} placeholder="e.g. CBSE" error={fe.board} />
        <TextField label="Affiliation number" name="affiliationNo" defaultValue={defaults.affiliationNo} error={fe.affiliationNo} />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Contact</legend>
        <TextField label="Email" name="email" type="email" defaultValue={defaults.email} error={fe.email} />
        <TextField label="Website" name="website" type="url" defaultValue={defaults.website} placeholder="https://" error={fe.website} />
        {[0, 1, 2].map((i) => (
          <TextField
            key={i}
            label={i === 0 ? "Phone" : `Phone ${i + 1} (optional)`}
            name={`phone${i + 1}`}
            type="tel"
            inputMode="tel"
            defaultValue={defaults.phones[i] ?? ""}
            error={fe[`phones.${i}`] ?? (i === 0 ? fe.phones : undefined)}
          />
        ))}
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Address</legend>
        <div className="sm:col-span-2">
          <TextField label="Street address" name="line1" defaultValue={defaults.line1} error={fe["address.line1"]} required />
        </div>
        <div className="sm:col-span-2">
          <TextField label="Address line 2 (optional)" name="line2" defaultValue={defaults.line2} error={fe["address.line2"]} />
        </div>
        <TextField label="City / town" name="city" defaultValue={defaults.city} error={fe["address.city"]} required />
        <TextField label="District (optional)" name="district" defaultValue={defaults.district} error={fe["address.district"]} />
        <TextField label="State" name="state" defaultValue={defaults.state} error={fe["address.state"]} required />
        <TextField label="PIN code" name="pinCode" inputMode="numeric" maxLength={6} defaultValue={defaults.pinCode} error={fe["address.pinCode"]} required />
        <TextField label="Country" name="country" defaultValue={defaults.country} error={fe["address.country"]} />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold">Regional & timings</legend>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="timezone">Time zone</Label>
          <select
            id="timezone"
            name="timezone"
            defaultValue={defaults.timezone}
            aria-invalid={fe.timezone ? true : undefined}
            aria-describedby="timezone-hint"
            className={SELECT_CLASS}
          >
            {timeZones.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
          <p id="timezone-hint" className="text-xs text-muted-foreground">
            {fe.timezone ?? "All dates and times in the ERP and on documents use this zone."}
          </p>
        </div>
        <SelectField label="Language & region" name="locale" defaultValue={defaults.locale} options={LOCALES} error={fe.locale} />
        <SelectField label="Date format on documents" name="dateFormat" defaultValue={defaults.dateFormat} options={DATE_FORMATS} error={fe.dateFormat} />
        <TextField label="Currency" name="currency" defaultValue={defaults.currency} maxLength={3} autoCapitalize="characters" hint="ISO code, e.g. INR." error={fe.currency} />
        <div className="hidden sm:block" aria-hidden="true" />
        <TextField label="School opens" name="opensAt" type="time" defaultValue={defaults.opensAt} error={fe["timings.opensAt"]} required />
        <TextField label="School closes" name="closesAt" type="time" defaultValue={defaults.closesAt} error={fe["timings.closesAt"]} required />
        <div className="sm:col-span-2">
          <TextField label="Office hours (optional)" name="officeHours" defaultValue={defaults.officeHours} placeholder="e.g. Mon–Sat 9:00–15:00" error={fe["timings.officeHours"]} />
        </div>
      </fieldset>

      <SubmitButton className="w-full sm:w-auto">Save school profile</SubmitButton>
    </form>
  );
}

const SELECT_CLASS = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

function SelectField({ label, name, defaultValue, options, error }: { label: string; name: string; defaultValue: string; options: readonly string[]; error?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <select id={name} name={name} defaultValue={defaultValue} aria-invalid={error ? true : undefined} aria-describedby={error ? `${name}-error` : undefined} className={SELECT_CLASS}>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {error && (
        <p id={`${name}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
