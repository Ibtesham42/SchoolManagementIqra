"use client";

import { useActionState, useState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { cancelInvoiceAction, issueInvoicesAction } from "./actions";

/** Issue the previewed run (one transaction; re-running only adds students not yet invoiced). */
export function IssueForm({ sessionId, classId, installmentId, count, total, rawTotal, structureId }: { sessionId: string; classId: string; installmentId: string; count: number; total: string; rawTotal: string; structureId: string }) {
  const [state, action] = useActionState(issueInvoicesAction, initialState);
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="academicSessionId" value={sessionId} />
      <input type="hidden" name="classId" value={classId} />
      <input type="hidden" name="installmentId" value={installmentId} />
      <input type="hidden" name="expectedCount" value={String(count)} />
      <input type="hidden" name="expectedTotal" value={rawTotal} />
      <input type="hidden" name="expectedStructure" value={structureId} />
      <FormStatus state={state} />
      {!state.ok && (
        <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Issuing…">
          Issue {count} invoice{count === 1 ? "" : "s"} (₹{total})
        </SubmitButton>
      )}
    </form>
  );
}

/** Cancel an unpaid invoice with a reason (FC5). */
export function CancelInvoiceForm({ id, version }: { id: string; version: number }) {
  const [state, action] = useActionState(cancelInvoiceAction, initialState);
  const [reason, setReason] = useState("");
  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="version" value={String(version)} />
      <label htmlFor={`cancel-${id}`} className="text-sm font-medium">
        Why is it cancelled?
      </label>
      <textarea id={`cancel-${id}`} name="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} maxLength={500} rows={2} className="min-h-20 rounded-lg border border-input bg-background px-3 py-2 text-base sm:text-sm" />
      <FormStatus state={state} />
      <SubmitButton variant="destructive" className="min-h-11 w-full sm:w-auto" pendingLabel="Cancelling…">
        Cancel invoice
      </SubmitButton>
    </form>
  );
}
