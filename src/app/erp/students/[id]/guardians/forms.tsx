"use client";

import { useActionState } from "react";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { FormStatus, SelectField, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { linkGuardianAction, mergeGuardiansAction } from "./actions";

const RELATIONS = [
  { value: "FATHER", label: "Father" },
  { value: "MOTHER", label: "Mother" },
  { value: "GUARDIAN", label: "Guardian" },
  { value: "OTHER", label: "Other" },
];

export function LinkGuardianForm({ studentId, guardianId }: { studentId: string; guardianId: string }) {
  const [state, action] = useActionState(linkGuardianAction, initialState);
  return (
    <form action={action} className="grid gap-2 sm:max-w-sm">
      <FormStatus state={state} />
      <input type="hidden" name="studentId" value={studentId} />
      <input type="hidden" name="guardianId" value={guardianId} />
      <SelectField id={`relation-${guardianId}`} label="Relation to this student" name="relation" defaultValue="GUARDIAN" options={RELATIONS} />
      <SubmitButton variant="outline" className="w-full sm:w-auto">
        Link to this student
      </SubmitButton>
    </form>
  );
}

export function MergeButton({ studentId, keepGuardianId, removeGuardianId, keepName, removeName, different }: { studentId: string; keepGuardianId: string; removeGuardianId: string; keepName: string; removeName: string; different: boolean }) {
  return (
    <ConfirmAction
      label={`Keep "${keepName}", merge the other record into it`}
      title="Merge these guardian records?"
      description={`${different ? `The names differ: only merge if "${keepName}" and "${removeName}" are the SAME person (parents often share one phone). ` : ""}Every student linked to "${removeName}" is linked to "${keepName}" instead, and the "${removeName}" record is removed. If "${keepName}" has a portal account, it will see all those students. This can't be undone from the screen.`}
      confirmLabel="Merge"
      variant="destructive"
      action={mergeGuardiansAction}
      fields={{ studentId, keepGuardianId, removeGuardianId, confirmDifferent: different ? "true" : "false" }}
    />
  );
}
