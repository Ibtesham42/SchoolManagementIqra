"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { OneTimeSecret } from "@/components/erp/one-time-secret";
import { initialState } from "@/lib/action-state";
import { createUserAction } from "../actions";
import { RoleCheckboxes, type RoleOption } from "../role-checkboxes";

/** Remounting with a new key gives "Create another" a fresh form and drops the shown password from memory. */
export function NewUserForm({ roles }: { roles: RoleOption[] }) {
  const [round, setRound] = useState(0);
  return <NewUserFormInner key={round} roles={roles} onAnother={() => setRound((r) => r + 1)} />;
}

function NewUserFormInner({ roles, onAnother }: { roles: RoleOption[]; onAnother: () => void }) {
  const [state, action] = useActionState(createUserAction, initialState);
  if (state.ok && state.secret) {
    return (
      <div className="grid gap-4">
        <OneTimeSecret label="Temporary password" value={state.secret} message={state.message} />
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/erp/users">Back to users</Link>
          </Button>
          <Button type="button" onClick={onAnother}>
            Create another
          </Button>
        </div>
      </div>
    );
  }
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="grid gap-4" noValidate>
      <FormStatus state={state} />
      <TextField label="Full name" name="displayName" autoComplete="off" error={fe.displayName} required />
      <TextField
        label="Username"
        name="username"
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        hint="Lowercase letters, digits, dot, dash or underscore. Used to sign in."
        error={fe.username}
        required
      />
      <TextField label="Email (optional)" name="email" type="email" autoComplete="off" hint="Needed for self-service password reset." error={fe.email} />
      <RoleCheckboxes roles={roles} selected={[]} error={fe.roleKeys} />
      <SubmitButton className="w-full sm:w-auto">Create user</SubmitButton>
    </form>
  );
}
