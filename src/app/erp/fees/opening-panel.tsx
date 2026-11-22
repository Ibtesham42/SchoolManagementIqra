"use client";

import { useActionState, useState } from "react";
import { Download } from "lucide-react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { confirmOpeningAction, previewOpeningAction, type OpeningPreviewState } from "./opening-actions";

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

/** Phase 5C-M3: template → fill in previous dues → check the file → choose the due date → confirm. Mobile: one column. */
export function OpeningPanel({ academicSessionId, classId, defaultDueOn, templateError }: { academicSessionId: string; classId: string; defaultDueOn: string; templateError: string | null }) {
  const [preview, previewAction] = useActionState<OpeningPreviewState, FormData>(previewOpeningAction, initialState);
  const [confirmed, confirmAction] = useActionState(confirmOpeningAction, initialState);
  const [dueOn, setDueOn] = useState(defaultDueOn);
  const p = preview.preview;
  const problems = p ? p.plan.rows.filter((r) => r.problem) : [];
  const adding = p ? p.plan.rows.filter((r) => r.status === "new") : [];
  const existing = p ? p.plan.rows.filter((r) => r.status === "existing") : [];
  return (
    <div className="grid gap-4 text-sm">
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Download the template: it lists this class&apos;s students and any previous dues already added.</li>
        <li>Write each student&apos;s unpaid amount from the old system in &quot;Previous dues (Rs.)&quot;. Leave it blank or 0 for none.</li>
        <li>Upload the file, check the preview, choose when the dues fall due, then confirm.</li>
      </ol>
      <div className="flex flex-wrap gap-2">
        {(["xlsx", "csv"] as const).map((format) => (
          <form key={format} method="post" action="/api/v1/fees/opening-balances/template">
            <input type="hidden" name="academicSessionId" value={academicSessionId} />
            <input type="hidden" name="classId" value={classId} />
            <input type="hidden" name="format" value={format} />
            <Button type="submit" variant="outline" className="min-h-11">
              <Download aria-hidden="true" /> Template ({format.toUpperCase()})
            </Button>
          </form>
        ))}
      </div>
      {templateError && (
        <p role="alert" className="text-destructive">
          {templateError}
        </p>
      )}
      <form action={previewAction} className="grid gap-2">
        <input type="hidden" name="academicSessionId" value={academicSessionId} />
        <input type="hidden" name="classId" value={classId} />
        <label htmlFor="opening-file" className="font-medium">
          Filled-in file (.xlsx or .csv, up to 512 KB)
        </label>
        <input id="opening-file" name="file" type="file" required accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="min-h-11 rounded-lg border border-input p-2" />
        <SubmitButton pendingLabel="Checking…" className="min-h-11 justify-self-start">
          Check file
        </SubmitButton>
        {!preview.ok && <FormStatus state={preview} />}
      </form>
      {p && (
        <section aria-label="Import preview" className="grid gap-3">
          <h3 className="font-medium">Preview of {p.fileName}</h3>
          {p.plan.fileProblem ? (
            <p role="alert" className="text-destructive">
              {p.plan.fileProblem}
            </p>
          ) : (
            <p>
              {p.plan.counts.new} to add (₹{p.plan.total}) · {p.plan.counts.existing} already added · {p.plan.counts.blank} with none · {p.plan.counts.notInFile} not in the file
              {p.plan.counts.problems > 0 && <span className="text-destructive"> · {p.plan.counts.problems} with problems</span>}
            </p>
          )}
          {problems.length > 0 && (
            <div className="grid gap-1">
              <p className="font-medium text-destructive">Fix these rows in the file and upload it again. Nothing is added while any row has a problem.</p>
              <ul className="grid gap-1">
                {problems.slice(0, 50).map((r) => (
                  <li key={r.line} className="rounded-lg border border-destructive/40 p-2">
                    Row {r.line}
                    {r.studentCode && ` · ${r.studentCode}`}
                    {r.fullName && ` · ${r.fullName}`}: {r.problem}
                  </li>
                ))}
              </ul>
              {problems.length > 50 && <p className="text-muted-foreground">…and {problems.length - 50} more.</p>}
            </div>
          )}
          {adding.length > 0 && (
            <ul className="grid gap-1">
              {adding.slice(0, 200).map((r) => (
                <li key={r.line} className="flex flex-wrap justify-between gap-2 rounded-lg border p-2">
                  <span>
                    {r.fullName} <span className="text-muted-foreground">{r.studentCode}</span>
                  </span>
                  <span className="tabular-nums">₹{r.amount}</span>
                </li>
              ))}
            </ul>
          )}
          {existing.length > 0 && <p className="text-muted-foreground">{existing.length} student{existing.length === 1 ? " already has" : "s already have"} previous dues and will be skipped. To change one, cancel that invoice on the student&apos;s fee page first.</p>}
          {p.canConfirm && !confirmed.ok && (
            <form action={confirmAction} className="grid gap-2">
              <input type="hidden" name="academicSessionId" value={academicSessionId} />
              <input type="hidden" name="classId" value={classId} />
              <input type="hidden" name="entries" value={JSON.stringify(p.plan.entries)} />
              <input type="hidden" name="expectedTotal" value={p.plan.total} />
              <label htmlFor="opening-due" className="font-medium">
                Due on
              </label>
              <input id="opening-due" name="dueOn" type="date" required value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={FIELD} aria-describedby="opening-due-hint" />
              <p id="opening-due-hint" className="text-muted-foreground">
                Within the academic session and at most 30 days ago. The session&apos;s late-fee rule applies to unpaid previous dues after this date.
              </p>
              <SubmitButton pendingLabel="Adding…" className="min-h-11 justify-self-start">
                Add previous dues for {p.plan.entries.length} {p.plan.entries.length === 1 ? "student" : "students"} (₹{p.plan.total})
              </SubmitButton>
            </form>
          )}
          {!p.plan.fileProblem && problems.length === 0 && p.plan.entries.length === 0 && <p className="text-muted-foreground">Nothing to add from this file.</p>}
          <FormStatus state={confirmed} />
        </section>
      )}
    </div>
  );
}
