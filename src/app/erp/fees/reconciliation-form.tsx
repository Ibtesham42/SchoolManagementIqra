"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { Badge } from "@/components/ui/badge";
import { runReconciliationAction, type ReconciliationState } from "./actions";

/** Run the reconciliation checks (POSTed, rate limited) and show each check with its problems and sample numbers. */
export function ReconciliationRunner() {
  const [state, action] = useActionState<ReconciliationState, FormData>(runReconciliationAction, initialState);
  const r = state.result;
  return (
    <div className="grid gap-4">
      <form action={action}>
        <SubmitButton className="min-h-11 w-full sm:w-auto" pendingLabel="Checking…">
          {r ? "Run the checks again" : "Run the checks"}
        </SubmitButton>
      </form>
      {state.error && <FormStatus state={state} />}
      {r && (
        <>
          <p role="status" className="text-sm font-medium">
            {r.problems === 0 ? "Everything reconciles." : `${r.problems} problem${r.problems === 1 ? "" : "s"} found. Ask the system administrator to look into them before closing the books.`}
          </p>
          <ul className="grid gap-2">
            {r.checks.map((c) => (
              <li key={c.key} className="grid gap-1 rounded-xl border p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{c.title}</span>
                  {c.problems === 0 ? <Badge variant="secondary">OK</Badge> : <Badge variant="destructive">{c.problems} problem{c.problems === 1 ? "" : "s"}</Badge>}
                </div>
                <p className="text-muted-foreground">{c.explain}</p>
                {c.samples.length > 0 && (
                  <p className="break-words font-mono text-xs">
                    {c.samples.join(", ")}
                    {c.problems > c.samples.length && " …"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
