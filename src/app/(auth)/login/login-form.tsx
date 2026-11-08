"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { loginAction } from "./actions";

export function LoginForm() {
  const [state, action] = useActionState(loginAction, initialState);
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <TextField label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required />
      <TextField label="Password" name="password" type="password" autoComplete="current-password" required />
      <div className="flex min-h-11 items-center gap-3">
        <Checkbox id="remember" name="remember" />
        <Label htmlFor="remember" className="font-normal">
          Keep me signed in on this device (parents and students)
        </Label>
      </div>
      <SubmitButton className="w-full">Sign in</SubmitButton>
      <Link href="/forgot-password" className="inline-flex min-h-11 items-center justify-center text-sm text-primary underline-offset-4 hover:underline">
        Forgot your password?
      </Link>
    </form>
  );
}
