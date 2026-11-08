"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/(auth)/login/actions";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePasswordAction, initialState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <TextField label="Current password" name="currentPassword" type="password" autoComplete="current-password" error={fe.currentPassword} required />
      <TextField label="New password" name="newPassword" type="password" autoComplete="new-password" minLength={10} error={fe.newPassword} required />
      <TextField label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" error={fe.confirmPassword} required />
      <SubmitButton className="w-full sm:w-auto">Update password</SubmitButton>
    </form>
  );
}
