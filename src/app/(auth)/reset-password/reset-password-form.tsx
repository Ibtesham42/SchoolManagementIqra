"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { completeResetAction } from "../password-reset-actions";

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action] = useActionState(completeResetAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="token" value={token} />
      <TextField label="New password" name="newPassword" type="password" autoComplete="new-password" minLength={10} error={fe.newPassword} required />
      <TextField label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" error={fe.confirmPassword} required />
      <SubmitButton className="w-full">Set new password</SubmitButton>
    </form>
  );
}
