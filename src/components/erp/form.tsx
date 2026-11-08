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
  ...props
}: { label: string; name: string; error?: string; hint?: string } & ComponentProps<typeof Input>) {
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...props} />
      {hint && !error && (
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} className="text-sm text-destructive">
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
