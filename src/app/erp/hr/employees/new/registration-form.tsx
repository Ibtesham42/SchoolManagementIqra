"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import {
  FormStatus,
  SelectField,
  SubmitButton,
  TextField,
} from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { registerEmployeeAction } from "../../actions";

export interface Option {
  value: string;
  label: string;
}

const STEPS = ["Personal", "Contact", "Employment", "Review"] as const;
/** Which step owns a server field error (paths as fromZod builds them, e.g. "address.city"). */
function stepOf(path: string): number {
  if (["firstName", "middleName", "lastName", "dob", "gender"].includes(path))
    return 0;
  if (
    ["personalPhone", "workPhone", "personalEmail", "workEmail"].includes(
      path,
    ) ||
    path.startsWith("address") ||
    path.startsWith("emergencyContact")
  )
    return 1;
  return 2;
}

const GENDER_OPTIONS = [
  { value: "", label: "Choose…" },
  { value: "FEMALE", label: "Female" },
  { value: "MALE", label: "Male" },
  { value: "OTHER", label: "Other" },
];

/**
 * Multi-step registration (PHASE_3_PLAN.md §7): one form, one step visible at a time, every field submitted
 * together; the server validates everything again and assigns the permanent employee ID.
 */
export function RegistrationForm({
  departments,
  designations,
  managers,
  appointmentTypes,
  today,
}: {
  departments: Option[];
  designations: Option[];
  managers: Option[];
  appointmentTypes: Option[];
  today: string;
}) {
  const [state, action] = useActionState(registerEmployeeAction, initialState);
  const [step, setStep] = useState(0);
  const [summary, setSummary] = useState<[string, string][]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const fe = state.fieldErrors ?? {};

  // After a refused submit, go back to the first step that has an error (state adjusted during render
  // when a new action result arrives — React's pattern for deriving state from a changed value).
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    const paths = Object.keys(state.fieldErrors ?? {});
    if (paths.length) setStep(Math.min(...paths.map(stepOf)));
  }
  // Move focus to the step heading when the step changes (not on first load), so screen readers announce it.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  function go(next: number) {
    if (next === 3 && formRef.current) {
      const fd = new FormData(formRef.current);
      const v = (k: string) => String(fd.get(k) ?? "").trim();
      const label = (opts: Option[], k: string) =>
        opts.find((o) => o.value === v(k))?.label ?? "—";
      setSummary([
        [
          "Name",
          [v("firstName"), v("middleName"), v("lastName")]
            .filter(Boolean)
            .join(" ") || "—",
        ],
        ["Date of birth", v("dob") || "—"],
        ["Gender", label(GENDER_OPTIONS, "gender")],
        ["Personal phone", v("personalPhone") || "—"],
        ["Work phone", v("workPhone") || "—"],
        ["Work email", v("workEmail") || "—"],
        [
          "Address",
          [v("line1"), v("city"), v("state"), v("pinCode")]
            .filter(Boolean)
            .join(", ") || "Not entered",
        ],
        [
          "Emergency contact",
          v("ecName")
            ? `${v("ecName")} (${v("ecRelation")}) ${v("ecPhone")}`
            : "Not entered",
        ],
        ["Department", label(departments, "departmentId")],
        ["Designation", label(designations, "designationId")],
        ["Appointment", label(appointmentTypes, "appointmentType")],
        ["Joining date", v("joiningDate") || "—"],
        ["Confirmation date", v("confirmationDate") || "—"],
        [
          "Reports to",
          v("reportsToId") ? label(managers, "reportsToId") : "Nobody",
        ],
      ]);
    }
    setStep(next);
  }

  const section = (i: number) => ({
    hidden: step !== i,
    "aria-labelledby": `step-${i}-title`,
  });

  return (
    <form ref={formRef} action={action} className="grid gap-4" noValidate>
      <ol className="flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            aria-current={i === step ? "step" : undefined}
            className={i === step ? "font-semibold" : "text-muted-foreground"}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </h2>
      <FormStatus state={state} />

      <section {...section(0)} className="grid gap-4 sm:grid-cols-2">
        <h3 id="step-0-title" className="sr-only">
          Personal details
        </h3>
        <TextField
          label="First name"
          name="firstName"
          maxLength={60}
          error={fe.firstName}
          required
          autoComplete="off"
        />
        <TextField
          label="Middle name (optional)"
          name="middleName"
          maxLength={60}
          error={fe.middleName}
          autoComplete="off"
        />
        <TextField
          label="Last name (optional)"
          name="lastName"
          maxLength={60}
          error={fe.lastName}
          autoComplete="off"
        />
        <TextField
          label="Date of birth"
          name="dob"
          type="date"
          min="1940-01-01"
          max={today}
          error={fe.dob}
          required
        />
        <SelectField
          label="Gender"
          name="gender"
          options={GENDER_OPTIONS}
          defaultValue=""
          error={fe.gender}
          required
        />
      </section>

      <section {...section(1)} className="grid gap-4">
        <h3 id="step-1-title" className="sr-only">
          Contact details
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Personal phone"
            name="personalPhone"
            type="tel"
            inputMode="tel"
            error={fe.personalPhone}
            hint="10 digits; +91 allowed."
            required
            autoComplete="off"
          />
          <TextField
            label="Work phone (optional)"
            name="workPhone"
            type="tel"
            inputMode="tel"
            error={fe.workPhone}
            autoComplete="off"
          />
          <TextField
            label="Personal email (optional)"
            name="personalEmail"
            type="email"
            error={fe.personalEmail}
            autoComplete="off"
          />
          <TextField
            label="Work email (optional)"
            name="workEmail"
            type="email"
            error={fe.workEmail}
            autoComplete="off"
          />
        </div>
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold">
            Home address (optional — fill in all or nothing)
          </legend>
          <div className="sm:col-span-2">
            <TextField
              label="Address line 1"
              name="line1"
              error={fe["address.line1"]}
              autoComplete="off"
            />
          </div>
          <div className="sm:col-span-2">
            <TextField
              label="Address line 2"
              name="line2"
              error={fe["address.line2"]}
              autoComplete="off"
            />
          </div>
          <TextField
            label="City / town"
            name="city"
            error={fe["address.city"]}
            autoComplete="off"
          />
          <TextField
            label="District"
            name="district"
            error={fe["address.district"]}
            autoComplete="off"
          />
          <TextField
            label="State"
            name="state"
            error={fe["address.state"]}
            autoComplete="off"
          />
          <TextField
            label="PIN code"
            name="pinCode"
            inputMode="numeric"
            maxLength={6}
            error={fe["address.pinCode"]}
            autoComplete="off"
          />
          <TextField
            label="Country"
            name="country"
            defaultValue="India"
            error={fe["address.country"]}
            autoComplete="off"
          />
        </fieldset>
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold">
            Emergency contact (optional)
          </legend>
          <TextField
            label="Name"
            name="ecName"
            error={fe["emergencyContact.name"]}
            autoComplete="off"
          />
          <TextField
            label="Relationship"
            name="ecRelation"
            placeholder="Spouse"
            error={fe["emergencyContact.relation"]}
            autoComplete="off"
          />
          <TextField
            label="Phone"
            name="ecPhone"
            type="tel"
            inputMode="tel"
            error={fe["emergencyContact.phone"]}
            autoComplete="off"
          />
        </fieldset>
      </section>

      <section {...section(2)} className="grid gap-4 sm:grid-cols-2">
        <h3 id="step-2-title" className="sr-only">
          Employment
        </h3>
        <SelectField
          label="Department"
          name="departmentId"
          options={[{ value: "", label: "Choose…" }, ...departments]}
          defaultValue=""
          error={fe.departmentId}
          required
        />
        <SelectField
          label="Designation"
          name="designationId"
          options={[{ value: "", label: "Choose…" }, ...designations]}
          defaultValue=""
          error={fe.designationId}
          hint="Sets teaching or non-teaching."
          required
        />
        <SelectField
          label="Appointment type"
          name="appointmentType"
          options={[{ value: "", label: "Choose…" }, ...appointmentTypes]}
          defaultValue=""
          error={fe.appointmentType}
          required
        />
        <TextField
          label="Joining date"
          name="joiningDate"
          type="date"
          min="1940-01-01"
          error={fe.joiningDate}
          hint="Up to 90 days ahead. Sets the year in the employee ID."
          required
        />
        <TextField
          label="Confirmation date (optional)"
          name="confirmationDate"
          type="date"
          error={fe.confirmationDate}
        />
        <SelectField
          label="Reports to (optional)"
          name="reportsToId"
          options={[{ value: "", label: "Nobody" }, ...managers]}
          defaultValue=""
          error={fe.reportsToId}
        />
      </section>

      <section {...section(3)} className="grid gap-3">
        <h3 id="step-3-title" className="sr-only">
          Review
        </h3>
        <p className="text-sm text-muted-foreground">
          Check the details. The employee ID is assigned when you register and
          never changes.
        </p>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {summary.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <div className="sticky bottom-16 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur lg:bottom-0">
        <div className="flex gap-2">
          {step > 0 && (
            <Button
              type="button"
              variant="outline"
              className="flex-1 sm:flex-none"
              onClick={() => go(step - 1)}
            >
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button
              type="button"
              className="flex-1 sm:ml-auto sm:flex-none"
              onClick={() => go(step + 1)}
            >
              Next
            </Button>
          ) : (
            <SubmitButton
              className="flex-1 sm:ml-auto sm:flex-none"
              pendingLabel="Registering…"
            >
              Register employee
            </SubmitButton>
          )}
        </div>
      </div>
    </form>
  );
}
