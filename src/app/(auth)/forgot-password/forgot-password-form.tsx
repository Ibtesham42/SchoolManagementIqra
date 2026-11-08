"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { requestResetAction } from "../password-reset-actions";

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestResetAction, initialState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      {!state.ok && (
        <>
          <TextField label="Username or email" name="identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
          <SubmitButton className="w-full">Send reset link</SubmitButton>
        </>
      )}
      <Link href="/login" className="inline-flex min-h-11 items-center justify-center text-sm text-primary underline-offset-4 hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}
