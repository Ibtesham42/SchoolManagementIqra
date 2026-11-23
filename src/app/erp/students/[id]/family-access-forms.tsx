"use client";

import { useActionState } from "react";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { FormStatus, SubmitButton, TextField } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { setFamilyAccountActiveAction, setPortalAccessAction } from "./family-actions";

export function PortalAccessToggle({ studentId, guardianId, portalAccess, name }: { studentId: string; guardianId: string; portalAccess: boolean; name: string }) {
  return portalAccess ? (
    <ConfirmAction
      label="Block portal view of this student"
      title={`Block ${name} from this student?`}
      description="Their portal account stops showing this student from their next page view. They are not told why. Other children stay visible."
      confirmLabel="Block"
      variant="destructive"
      action={setPortalAccessAction}
      fields={{ studentId, guardianId, portalAccess: "false" }}
    />
  ) : (
    <ConfirmAction
      label="Allow portal view again"
      title={`Allow ${name} to see this student again?`}
      description="The student appears in their portal account again from their next page view."
      confirmLabel="Allow"
      action={setPortalAccessAction}
      fields={{ studentId, guardianId, portalAccess: "true" }}
    />
  );
}

export function AccountActiveForm({ studentId, guardianId, active }: { studentId: string; guardianId: string; active: boolean }) {
  const [state, action] = useActionState(setFamilyAccountActiveAction, initialState);
  return (
    <form action={action} className="grid gap-2 sm:max-w-md">
      <FormStatus state={state} />
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="guardianId" value={guardianId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <TextField id={`reason-${guardianId}`} label={active ? "Reason for deactivating" : "Reason for reactivating"} name="reason" maxLength={300} error={state.fieldErrors?.reason} required />
      <SubmitButton variant={active ? "destructive" : "outline"} className="w-full sm:w-auto">
        {active ? "Deactivate account" : "Reactivate account"}
      </SubmitButton>
    </form>
  );
}
