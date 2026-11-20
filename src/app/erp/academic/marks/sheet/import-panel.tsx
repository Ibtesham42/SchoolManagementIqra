"use client";

import { useActionState, useState } from "react";
import { Download, FileUp } from "lucide-react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { initialState } from "@/lib/action-state";
import { confirmMarksImportAction, previewMarksImportAction, type ImportPreviewState } from "./import-actions";

const CHANGE_LABEL = { new: "New", changed: "Changed", same: "No change", blank: "Blank" } as const;
const STATUS_LABEL = { PRESENT: "", ABSENT: "AB", EXEMPT: "EX" } as const;

/** Phase 4C-M4: download the template → fill it in → check the file → confirm. Mobile: one column, 44 px targets. */
export function ImportPanel({ examSubjectId, sectionId, correction, templateError }: { examSubjectId: string; sectionId: string; correction: boolean; templateError: string | null }) {
  const [preview, previewAction] = useActionState<ImportPreviewState, FormData>(previewMarksImportAction, initialState);
  const [confirmed, confirmAction] = useActionState(confirmMarksImportAction, initialState);
  const [reason, setReason] = useState("");
  const p = preview.preview;
  const problems = p ? p.plan.rows.filter((r) => r.problem) : [];
  const changes = p ? p.plan.rows.filter((r) => !r.problem && (r.change === "new" || r.change === "changed")) : [];

  return (
    <details className="rounded-lg border p-3" open={templateError !== null || undefined}>
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 font-medium">
        <FileUp className="size-4" aria-hidden="true" /> Import marks from a spreadsheet
      </summary>
      <div className="mt-3 grid gap-4 text-sm">
        <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Download the template: it lists this sheet&apos;s students and any saved marks.</li>
          <li>Fill in the marks. Use AB for absent and EX for exempt. A blank cell keeps the saved mark.</li>
          <li>Upload the file, check the preview, then confirm.</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          {(["xlsx", "csv"] as const).map((format) => (
            <form key={format} method="post" action="/api/v1/academic/marks/template">
              <input type="hidden" name="examSubjectId" value={examSubjectId} />
              <input type="hidden" name="sectionId" value={sectionId} />
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
          <input type="hidden" name="examSubjectId" value={examSubjectId} />
          <input type="hidden" name="sectionId" value={sectionId} />
          <label htmlFor="marks-file" className="font-medium">
            Filled-in file (.xlsx or .csv, up to 512 KB)
          </label>
          <input id="marks-file" name="file" type="file" required accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="min-h-11 rounded-lg border border-input p-2" />
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
                {p.plan.counts.new} new · {p.plan.counts.changed} changed · {p.plan.counts.same} unchanged · {p.plan.counts.blank} blank · {p.plan.counts.notInFile} not in the file
                {p.plan.counts.problems > 0 && <span className="text-destructive"> · {p.plan.counts.problems} with problems</span>}
              </p>
            )}
            {problems.length > 0 && (
              <div className="grid gap-1">
                <p className="font-medium text-destructive">Fix these rows in the file and upload it again. Nothing is imported while any row has a problem.</p>
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
            {changes.length > 0 && (
              <ul className="grid gap-1">
                {changes.slice(0, 200).map((r) => (
                  <li key={r.line} className="flex flex-wrap justify-between gap-2 rounded-lg border p-2">
                    <span>{r.fullName}</span>
                    <span className="tabular-nums">
                      {r.entry && (r.entry.status !== "PRESENT" ? STATUS_LABEL[r.entry.status] : [r.entry.theory, r.entry.practical, r.entry.internal].filter((v) => v !== null).join(" + ") || "—")}
                      <span className="ml-2 text-muted-foreground">{r.change && CHANGE_LABEL[r.change]}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {p.canConfirm && !confirmed.ok && (
              <form action={confirmAction} className="grid gap-2">
                <input type="hidden" name="examSubjectId" value={examSubjectId} />
                <input type="hidden" name="sectionId" value={sectionId} />
                <input type="hidden" name="sheetVersion" value={p.sheetVersion === null ? "" : String(p.sheetVersion)} />
                <input type="hidden" name="entries" value={JSON.stringify(p.plan.entries)} />
                {(correction || p.mode === "correct") && (
                  <>
                    <label htmlFor="import-reason" className="font-medium">
                      Reason for correcting approved marks
                    </label>
                    <textarea id="import-reason" name="reason" required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-20 rounded-lg border border-input p-2" />
                  </>
                )}
                <SubmitButton pendingLabel="Importing…" className="min-h-11 justify-self-start">
                  Import {p.plan.entries.length} {p.plan.entries.length === 1 ? "student" : "students"}
                </SubmitButton>
              </form>
            )}
            {p && !p.plan.fileProblem && problems.length === 0 && p.plan.entries.length === 0 && <p className="text-muted-foreground">Nothing to import: the file matches the saved marks.</p>}
            <FormStatus state={confirmed} />
          </section>
        )}
      </div>
    </details>
  );
}
