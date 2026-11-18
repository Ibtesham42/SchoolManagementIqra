"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { saveTeacherProfileAction } from "../../actions";

export interface Qualification {
  degree: string;
  subject: string | null;
  institution: string | null;
  year: number | null;
}
export interface ProfessionalQualification {
  name: string;
  year: number | null;
}
export interface TeacherProfileDefaults {
  version: number | null;
  qualifications: Qualification[];
  professionalQualifications: ProfessionalQualification[];
  specializations: string[];
  experienceYearsBefore: number;
  teacherRegistrationNo: string | null;
}

const MAX = 10;
const str = (v: string | number | null | undefined) =>
  v === null || v === undefined ? "" : String(v);

/** Create or edit the teacher profile. Rows left blank are ignored; the server validates everything again. */
export function TeacherProfileForm({
  employeeId,
  d,
}: {
  employeeId: string;
  d: TeacherProfileDefaults;
}) {
  const [state, action] = useActionState(
    saveTeacherProfileAction,
    initialState,
  );
  const [qRows, setQRows] = useState(
    Math.min(
      MAX,
      Math.max(
        1,
        d.qualifications.length + (d.qualifications.length < MAX ? 1 : 0),
      ),
    ),
  );
  const [pqRows, setPqRows] = useState(
    Math.min(
      MAX,
      Math.max(
        1,
        d.professionalQualifications.length +
          (d.professionalQualifications.length < MAX ? 1 : 0),
      ),
    ),
  );
  const fe = state.fieldErrors ?? {};
  const err = (prefix: string) =>
    Object.entries(fe).find(
      ([k]) => k === prefix || k.startsWith(`${prefix}.`),
    )?.[1];

  return (
    <form action={action} className="grid gap-5" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <input type="hidden" name="version" value={d.version ?? ""} />

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">
          Academic qualifications
        </legend>
        {err("qualifications") && (
          <p className="text-sm text-destructive">{err("qualifications")}</p>
        )}
        {Array.from({ length: qRows }, (_, i) => {
          const q = d.qualifications[i];
          return (
            <div
              key={i}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-4"
            >
              <TextField
                label="Degree"
                id={`q-${i}-degree`}
                name={`q.${i}.degree`}
                defaultValue={str(q?.degree)}
                placeholder="M.Sc."
                maxLength={80}
                error={fe[`qualifications.${i}.degree`]}
              />
              <TextField
                label="Subject"
                id={`q-${i}-subject`}
                name={`q.${i}.subject`}
                defaultValue={str(q?.subject)}
                placeholder="Physics"
                maxLength={80}
                error={fe[`qualifications.${i}.subject`]}
              />
              <TextField
                label="Institution"
                id={`q-${i}-inst`}
                name={`q.${i}.institution`}
                defaultValue={str(q?.institution)}
                maxLength={120}
                error={fe[`qualifications.${i}.institution`]}
              />
              <TextField
                label="Year"
                id={`q-${i}-year`}
                name={`q.${i}.year`}
                inputMode="numeric"
                maxLength={4}
                defaultValue={str(q?.year)}
                error={fe[`qualifications.${i}.year`]}
              />
            </div>
          );
        })}
        {qRows < MAX && (
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-fit"
            onClick={() => setQRows((n) => Math.min(MAX, n + 1))}
          >
            <Plus aria-hidden="true" /> Add a qualification
          </Button>
        )}
      </fieldset>

      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-semibold">
          Professional qualifications (e.g. B.Ed, CTET)
        </legend>
        {err("professionalQualifications") && (
          <p className="text-sm text-destructive">
            {err("professionalQualifications")}
          </p>
        )}
        {Array.from({ length: pqRows }, (_, i) => {
          const q = d.professionalQualifications[i];
          return (
            <div
              key={i}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_8rem]"
            >
              <TextField
                label="Qualification"
                id={`pq-${i}-name`}
                name={`pq.${i}.name`}
                defaultValue={str(q?.name)}
                placeholder="B.Ed"
                maxLength={80}
                error={fe[`professionalQualifications.${i}.name`]}
              />
              <TextField
                label="Year"
                id={`pq-${i}-year`}
                name={`pq.${i}.year`}
                inputMode="numeric"
                maxLength={4}
                defaultValue={str(q?.year)}
                error={fe[`professionalQualifications.${i}.year`]}
              />
            </div>
          );
        })}
        {pqRows < MAX && (
          <Button
            type="button"
            variant="outline"
            className="w-full sm:w-fit"
            onClick={() => setPqRows((n) => Math.min(MAX, n + 1))}
          >
            <Plus aria-hidden="true" /> Add a professional qualification
          </Button>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <TextField
            label="Subjects taught"
            id="tp-spec"
            name="specializations"
            defaultValue={d.specializations.join(", ")}
            placeholder="Physics, Mathematics"
            hint="Separate with commas. Up to 10 subjects of 60 characters."
            error={err("specializations")}
          />
        </div>
        <TextField
          label="Experience before joining (years)"
          id="tp-exp"
          name="experienceYearsBefore"
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          defaultValue={String(d.experienceYearsBefore)}
          error={fe.experienceYearsBefore}
        />
        <TextField
          label="Teacher registration no. (optional)"
          id="tp-reg"
          name="teacherRegistrationNo"
          defaultValue={str(d.teacherRegistrationNo)}
          maxLength={40}
          error={fe.teacherRegistrationNo}
        />
      </div>
      <SubmitButton className="w-full sm:w-fit">
        Save teacher profile
      </SubmitButton>
    </form>
  );
}
