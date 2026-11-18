"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";

/** Labelled input with accessible error text (aria-invalid + aria-describedby). */
export function TextField({
  label,
  name,
  error,
  hint,
  id,
  ...props
}: { label: string; name: string; error?: string; hint?: string } & ComponentProps<typeof Input>) {
  // `id` defaults to `name`; pass one when the same field name appears in several forms on a page.
  const fieldId = id ?? name;
  const describedBy = [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <Input id={fieldId} name={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
      {hint && !error && (
        <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Form-level result banner. role="alert" scoped inside the form for screen readers and tests. */
export function FormStatus({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle aria-hidden="true" />
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }
  if (state.ok && state.message) {
    return (
      <Alert role="status">
        <CheckCircle2 aria-hidden="true" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }
  return null;
}

export function SubmitButton({ children, pendingLabel = "Please wait…", ...props }: { children: ReactNode; pendingLabel?: string } & ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-disabled={pending} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}

const NATIVE_SELECT_CLASS = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

/** Labelled native <select> (works without JavaScript, 44 px on touch) with accessible error text. */
export function SelectField({
  label,
  name,
  options,
  error,
  hint,
  id,
  ...props
}: { label: string; name: string; options: { value: string; label: string }[]; error?: string; hint?: string } & Omit<ComponentProps<"select">, "children">) {
  const fieldId = id ?? name;
  const describedBy = [error ? `${fieldId}-error` : null, hint ? `${fieldId}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <select id={fieldId} name={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy} className={NATIVE_SELECT_CLASS} {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && !error && (
        <p id={`${fieldId}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
