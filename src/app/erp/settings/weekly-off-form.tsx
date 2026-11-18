"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { updateWeeklyOffAction } from "../hr/actions";

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const NTH = ["1st", "2nd", "3rd", "4th", "5th"];

/** L3: staff weekly off. Checkboxes post repeated `days` / `saturdays` values; the server validates the combination. */
export function WeeklyOffForm({
  days,
  saturdays,
}: {
  days: number[];
  saturdays: number[];
}) {
  const [state, action] = useActionState(updateWeeklyOffAction, initialState);
  const box = "flex min-h-11 items-center gap-3 text-sm";
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <fieldset className="grid gap-1 sm:grid-cols-4">
        <legend className="mb-1 text-sm font-semibold">Every week</legend>
        {DAYS.map((d, i) => (
          <label key={d} className={box}>
            <input
              type="checkbox"
              name="days"
              value={i}
              defaultChecked={days.includes(i)}
              className="size-5"
            />
            {d}
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-1 sm:grid-cols-5">
        <legend className="mb-1 text-sm font-semibold">
          Only some Saturdays (leave “Saturday” above unticked)
        </legend>
        {NTH.map((n, i) => (
          <label key={n} className={box}>
            <input
              type="checkbox"
              name="saturdays"
              value={i + 1}
              defaultChecked={saturdays.includes(i + 1)}
              className="size-5"
            />
            {n} Saturday
          </label>
        ))}
      </fieldset>
      <SubmitButton className="w-full sm:w-fit">Save weekly off</SubmitButton>
    </form>
  );
}
