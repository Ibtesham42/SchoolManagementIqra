"use client";

import { useActionState, useEffect, useRef } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { activateAction } from "./actions";

/**
 * Phase 6A-M3 — activation form. A link may carry the username / code in the URL FRAGMENT (`#u=…&code=…`, email
 * invitations in 6A-M3b): it is read once, removed from the address bar and history, and only POSTed.
 */
export function ActivateForm({ schoolName }: { schoolName: string }) {
  const [state, action] = useActionState(activateAction, initialState);
  const usernameRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!window.location.hash) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    // External system (URL fragment) → the uncontrolled inputs, once.
    if (usernameRef.current) usernameRef.current.value = (params.get("u") ?? "").slice(0, 100);
    if (codeRef.current) codeRef.current.value = (params.get("code") ?? "").slice(0, 40);
  }, []);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <TextField ref={usernameRef} label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} hint="As printed on your activation slip." required />
      <TextField ref={codeRef} label="Activation code" name="code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} hint="12 letters and digits, e.g. ABCD-EFGH-JKMN." required />
      <TextField label="Your child's date of birth" name="dob" type="date" hint="If you have more than one child at the school, any one of them." required />
      <fieldset className="grid gap-2 rounded-lg border p-3">
        <legend className="px-1 text-sm font-medium">Privacy notice</legend>
        <p className="text-sm text-muted-foreground">
          {schoolName} uses your child&apos;s school records (profile, attendance, results, homework, timetable and fees) to show them to you in this portal. Only you and the school
          see them. You can ask the school office to close your account at any time.
        </p>
        <div className="flex min-h-11 items-center gap-3">
          <Checkbox id="consent" name="consent" aria-invalid={fe.consent ? true : undefined} />
          <Label htmlFor="consent" className="font-normal">
            I have read the privacy notice and agree.
          </Label>
        </div>
      </fieldset>
      <TextField label="New password" name="newPassword" type="password" autoComplete="new-password" minLength={10} error={fe.newPassword} hint="At least 10 characters." required />
      <TextField label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" error={fe.confirmPassword} required />
      <SubmitButton className="w-full">Activate my account</SubmitButton>
    </form>
  );
}
