import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarCheck, Lock, LockOpen, Send, Trash2, Undo2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { NotFoundError } from "@/lib/errors";
import { EXAM_STATUS_LABEL, manualTransitions, scaleEditable, subjectsEditable, type ExamStatus } from "@/modules/academic/examinations.rules";
import { examAccess, getExam, listAddableClassSubjects } from "@/modules/academic/examinations.service";
import { listScales } from "@/modules/academic/grading.service";
import { SHEET_STATUS_LABEL, type SheetStatus } from "@/modules/academic/marks.rules";
import { examMarksAccess, getExamSheetOverview } from "@/modules/academic/marks.service";
import { canPublishResults } from "@/modules/academic/results.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../../academic-tabs";
import { deleteExamAction, lockExamMarksAction, publishResultsAction, removeExamSubjectAction, setExamStatusAction, unlockExamMarksAction } from "../../actions";
import { AddExamSubjectsForm, ExamForm, ExamSubjectForm } from "../exam-forms";

export const metadata = { title: "Exam" };

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
const STEP: Record<string, { label: string; description: string }> = {
  SCHEDULED: { label: "Schedule exam", description: "The grading scale becomes fixed. Subjects and maximum marks can still change until marks entry opens." },
  DRAFT: { label: "Back to draft", description: "The exam returns to draft; its grading scale can be changed again." },
  MARKS_ENTRY: { label: "Open marks entry", description: "Allocated teachers can enter marks. Subjects and maximum marks are then fixed." },
};

export default async function ExamPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuth();
  const access = examAccess(ctx);
  if (!access.read) return <NotPermitted />;
  const { id } = await params;
  const exam = await getExam(ctx, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const status = exam.status as ExamStatus;
  const open = exam.academicSession.status !== "CLOSED";
  const manage = access.manage && open;
  const marks = examMarksAccess(ctx);
  const marksStarted = status === "MARKS_ENTRY" || status === "LOCKED" || status === "PUBLISHED";
  const [scales, addable, overview] = await Promise.all([
    manage && scaleEditable(status) ? listScales(ctx) : Promise.resolve([]),
    manage && subjectsEditable(status) ? listAddableClassSubjects(ctx, exam.id) : Promise.resolve([]),
    marks.overview && marksStarted ? getExamSheetOverview(ctx, exam.id) : Promise.resolve(null),
  ]);
  const ref = { id: exam.id, version: String(exam.version) };

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title={exam.name} description={`${exam.academicSession.name} · grading scale ${exam.gradeScale.name}`} />
      <AcademicTabs current="exams" showClasses showSubjects showMarks={hasPermission(ctx, "marks.enter") || hasPermission(ctx, "marks.approve")} />
      <p className="text-sm">
        <Link href={`/erp/academic/exams?session=${exam.academicSession.id}`} className="underline">
          All exams
        </Link>
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center justify-between gap-2">
            <h2>Status</h2>
            <Badge variant={status === "PUBLISHED" ? "default" : "secondary"}>{EXAM_STATUS_LABEL[status]}</Badge>
          </CardTitle>
          <CardDescription>
            {exam.startDate ? `${formatDateOnly(exam.startDate)}${exam.endDate ? ` – ${formatDateOnly(exam.endDate)}` : ""}` : "Dates not set"} · Draft → Scheduled → Marks entry → Locked → Published
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {manage &&
            manualTransitions(status).map((to) => (
              <ConfirmAction
                key={to}
                label={STEP[to].label}
                icon={to === "DRAFT" || (status === "MARKS_ENTRY" && to === "SCHEDULED") ? <Undo2 aria-hidden="true" /> : <CalendarCheck aria-hidden="true" />}
                title={`${STEP[to].label}?`}
                description={status === "MARKS_ENTRY" && to === "SCHEDULED" ? "Only possible while no marks have been entered." : STEP[to].description}
                confirmLabel={STEP[to].label}
                action={setExamStatusAction}
                fields={{ ...ref, to }}
              />
            ))}
          {manage && status === "DRAFT" && (
            <ConfirmAction label="Delete draft" variant="destructive" icon={<Trash2 aria-hidden="true" />} title={`Delete ${exam.name}?`} description="The draft and its subjects are removed." confirmLabel="Delete" action={deleteExamAction} fields={ref} />
          )}
          {marks.lock && open && status === "MARKS_ENTRY" && (
            <ConfirmAction
              label="Lock marks"
              icon={<Lock aria-hidden="true" />}
              title="Lock all marks?"
              description="Every marks sheet must be approved and complete. After locking, results can be published."
              confirmLabel="Lock marks"
              action={lockExamMarksAction}
              fields={ref}
            />
          )}
          {marks.lock && open && status === "LOCKED" && (
            <ConfirmAction label="Reopen marks entry" icon={<LockOpen aria-hidden="true" />} title="Reopen marks entry?" description="Approved sheets stay approved; approvers can correct them with a reason, and teachers can enter marks for newly added students." confirmLabel="Reopen" action={unlockExamMarksAction} fields={ref} />
          )}
          {canPublishResults(ctx) && open && status === "LOCKED" && (
            <ConfirmAction
              label="Publish results"
              icon={<Send aria-hidden="true" />}
              title="Publish results?"
              description="A report card is created for every enrolled student from the locked marks. Published results can't be changed."
              confirmLabel="Publish"
              action={publishResultsAction}
              fields={ref}
            />
          )}
          {marksStarted && (
            <Link href={`/erp/academic/exams/${exam.id}/results`} className="inline-flex min-h-11 items-center rounded-lg border px-4 text-sm font-medium hover:bg-muted pointer-fine:min-h-9">
              {status === "PUBLISHED" ? "Results and report cards" : "Results preview"}
            </Link>
          )}
        </CardContent>
      </Card>

      {manage && subjectsEditable(status) && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Exam details</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ExamForm
              defaults={{ id: exam.id, version: exam.version, name: exam.name, gradeScaleId: exam.gradeScale.id, startDate: iso(exam.startDate), endDate: iso(exam.endDate) }}
              scales={scales.filter((s) => s.isActive || s.id === exam.gradeScale.id).map((s) => ({ id: s.id, name: s.name }))}
              scaleLocked={!scaleEditable(status)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Subjects ({exam.subjects.length})</h2>
          </CardTitle>
          <CardDescription>Maximum marks per part; a part with 0 isn&apos;t examined. AB counts 0; EX leaves the subject out of the total.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {exam.subjects.length === 0 && <p className="text-sm text-muted-foreground">No subjects yet.</p>}
          <ul className="grid gap-2">
            {exam.subjects.map((s) => (
              <li key={s.id} className="grid gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {s.classSubject.class.name} · {s.classSubject.subject.name}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    Th {s.maxTheory} · Pr {s.maxPractical} · In {s.maxInternal} = {s.maxTheory + s.maxPractical + s.maxInternal}
                    {s.passPercent !== null && ` · pass ${Number(s.passPercent.toString())} %`}
                    {s.examDate && ` · ${formatDateOnly(s.examDate)}`}
                  </span>
                </div>
                {manage && subjectsEditable(status) && (
                  <div className="flex flex-wrap items-start gap-2">
                    <details className="grow rounded-lg border p-3 open:pb-4">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit</summary>
                      <div className="mt-3">
                        <ExamSubjectForm
                          defaults={{
                            id: s.id,
                            version: s.version,
                            examDate: iso(s.examDate),
                            maxTheory: String(s.maxTheory),
                            maxPractical: String(s.maxPractical),
                            maxInternal: String(s.maxInternal),
                            passPercent: s.passPercent === null ? "" : String(Number(s.passPercent.toString())),
                          }}
                        />
                      </div>
                    </details>
                    <ConfirmAction
                      label="Remove"
                      variant="destructive"
                      icon={<Trash2 aria-hidden="true" />}
                      title={`Remove ${s.classSubject.subject.name} (${s.classSubject.class.name})?`}
                      description="The subject is taken out of this exam."
                      confirmLabel="Remove"
                      action={removeExamSubjectAction}
                      fields={{ id: s.id, version: String(s.version) }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {manage && subjectsEditable(status) && (
            <details className="rounded-lg border p-3 open:pb-4">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Add subjects</summary>
              <div className="mt-3">
                <AddExamSubjectsForm examinationId={exam.id} version={exam.version} options={addable.map((a) => ({ id: a.id, label: `${a.class.name} · ${a.subject.name}` }))} />
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {overview && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Marks sheets</h2>
            </CardTitle>
            <CardDescription>
              {overview.problems.length === 0 ? "Every sheet is approved and complete." : `${overview.rows.filter((r) => r.sheet_status === "APPROVED" && r.marked >= r.roster).length} of ${overview.rows.length} ready.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {overview.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No students take this exam&apos;s subjects yet.</p>
            ) : (
              <ul className="grid gap-2 md:grid-cols-2">
                {overview.rows.map((r) => (
                  <li key={`${r.exam_subject_id}|${r.section_id}`}>
                    <Link
                      href={`/erp/academic/marks/sheet?es=${r.exam_subject_id}&section=${r.section_id}`}
                      className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      <span>
                        <span className="font-medium">{r.section_code}</span> · {r.subject_name}
                      </span>
                      <span className="text-muted-foreground">
                        {r.marked}/{r.roster} · {r.sheet_status ? SHEET_STATUS_LABEL[r.sheet_status as SheetStatus] : "Not started"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
