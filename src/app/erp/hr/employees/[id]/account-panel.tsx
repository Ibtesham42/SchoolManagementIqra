"use client";

import { useActionState } from "react";
import { Unlink } from "lucide-react";
import { FormStatus, SelectField, SubmitButton } from "@/components/erp/form";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { initialState } from "@/lib/action-state";
import { linkStaffAccountAction, unlinkStaffAccountAction } from "../../actions";

export interface LinkedAccount {
  id: string;
  username: string;
  displayName: string;
  isActive: boolean;
}

/** Link an existing login account to this employee (H2: needs employee.manage + user.manage). */
export function LinkAccountForm({ employeeId, candidates }: { employeeId: string; candidates: { id: string; username: string; displayName: string }[] }) {
  const [state, action] = useActionState(linkStaffAccountAction, initialState);
  if (candidates.length === 0) return <p className="text-sm text-muted-foreground">There is no active account without an employee link. Create the account under Users first.</p>;
  return (
    <form action={action} className="grid gap-3" noValidate>
      <FormStatus state={state} />
      <input type="hidden" name="employeeId" value={employeeId} />
      <SelectField
        label="Account"
        id="link-user"
        name="userId"
        options={[{ value: "", label: "Choose an account…" }, ...candidates.map((c) => ({ value: c.id, label: `${c.username} — ${c.displayName}` }))]}
        defaultValue=""
        hint="Only active accounts that aren't linked to another employee. You can only link accounts whose permissions you also hold."
        error={state.fieldErrors?.userId}
        required
      />
      <SubmitButton className="w-full sm:w-fit">Link account</SubmitButton>
    </form>
  );
}

export function UnlinkAccount({ employeeId, username }: { employeeId: string; username: string }) {
  return (
    <ConfirmAction
      label="Unlink account"
      icon={<Unlink aria-hidden="true" />}
      variant="outline"
      title={`Unlink ${username}?`}
      description="The account keeps its roles and can still sign in; it is just no longer this employee's account. The change is recorded in the audit log."
      confirmLabel="Unlink"
      action={unlinkStaffAccountAction}
      fields={{ employeeId }}
    />
  );
}
