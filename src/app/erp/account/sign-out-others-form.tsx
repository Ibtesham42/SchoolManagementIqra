"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { signOutOtherDevicesAction } from "./actions";

export function SignOutOthersForm() {
  const [state, action] = useActionState(signOutOtherDevicesAction, initialState);
  return (
    <form action={action} className="grid gap-3">
      <FormStatus state={state} />
      <SubmitButton variant="outline" className="w-full sm:w-auto">
        Sign out other devices
      </SubmitButton>
    </form>
  );
}
