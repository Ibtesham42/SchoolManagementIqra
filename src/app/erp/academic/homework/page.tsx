import { Paperclip, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAuth } from "@/lib/auth/context";
import { NotFoundError } from "@/lib/errors";
import { formatDateOnly } from "@/lib/format";
import { getSectionHomework, homeworkAccess, listHomeworkSections } from "@/modules/academic/homework.service";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { removeHomeworkAction, removeHomeworkAttachmentAction } from "../actions";
import { HOMEWORK_UPLOAD_MESSAGES, isUploadCode } from "@/lib/http/upload-errors";
import { academicTabFlags } from "../tab-flags";
import { HomeworkForm } from "./homework-form";

export const metadata = { title: "Homework" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const iso = (d: Date) => d.toISOString().slice(0, 10);

export default async function HomeworkPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!homeworkAccess(ctx).any) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, currentId } = await listSessionsForSections(ctx).catch(() => ({ sessions: [], currentId: null }));
  const session = sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listHomeworkSections(ctx, session.id) : [];
  const section = sections.find((s) => s.id === sp.section) ?? sections[0];
  const data = section
    ? await getSectionHomework(ctx, section.id).catch((e: unknown) => {
        if (e instanceof NotFoundError) notFound();
        throw e;
      })
    : null;
  const postable = data?.subjects.filter((s) => s.canPost) ?? [];
  // Fixed text for an attachment upload result (never text from the URL).
  const upload = isUploadCode(sp.upload) ? sp.upload : null;
  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Homework" description="Homework for each section and subject. Students and parents will see it once the portal exists." />
      <AcademicTabs current="homework" {...academicTabFlags(ctx)} />
      {upload && (
        <Alert variant={upload === "ok" ? "default" : "destructive"}>
          <AlertDescription role={upload === "ok" ? "status" : "alert"}>{HOMEWORK_UPLOAD_MESSAGES[upload]}</AlertDescription>
        </Alert>
      )}
      {sections.length > 1 && section && (
        <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="grid gap-1.5 text-sm font-medium" htmlFor="hw-section">
            Section
            <select id="hw-section" name="section" defaultValue={section.id} className={FIELD}>
              {sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" className="min-h-11">
            Show
          </Button>
        </form>
      )}
      {!data ? (
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : "You don't teach or look after any section in the current session."}</AlertDescription>
        </Alert>
      ) : (
        <>
          {postable.length > 0 && !data.section.closed && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Post homework for {data.section.code}</h2>
                </CardTitle>
                <CardDescription>Due today or later, within {data.section.sessionName}.</CardDescription>
              </CardHeader>
              <CardContent>
                <HomeworkForm key={data.section.id} sectionId={data.section.id} subjects={postable} defaults={{ title: "", details: "", dueOn: "" }} minDue={data.today} maxDue={data.section.sessionEnd} />
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {data.section.code}: homework ({data.items.length})
                </h2>
              </CardTitle>
              <CardDescription>Newest due date first.</CardDescription>
            </CardHeader>
            <CardContent>
              {data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">No homework yet.</p>
              ) : (
                <ul className="grid gap-3">
                  {data.items.map((h) => {
                    const overdue = iso(h.dueOn) < data.today;
                    return (
                      <li key={h.id} className="grid gap-2 rounded-lg border p-3">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="font-medium">
                            {h.subjectName}: {h.title}
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Due {formatDateOnly(h.dueOn)}
                            {overdue ? " (past)" : ""} · set {formatDateOnly(h.assignedOn)}
                            {h.postedBy ? ` by ${h.postedBy}` : ""}
                          </span>
                        </div>
                        <p className="text-sm whitespace-pre-line">{h.details}</p>
                        {h.attachment && (
                          <a href={`/api/v1/academic/homework/${h.id}/attachment`} className="inline-flex min-h-11 items-center gap-2 text-sm underline pointer-fine:min-h-9">
                            <Paperclip className="size-4" aria-hidden="true" /> {h.attachment.name} ({kb(h.attachment.sizeBytes)})
                          </a>
                        )}
                        {h.canManage && !data.section.closed && (
                          <div className="flex flex-wrap items-start gap-2">
                            <details className="grow rounded-lg border p-3 open:pb-4">
                              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit</summary>
                              <div className="mt-3">
                                <HomeworkForm defaults={{ id: h.id, version: h.version, title: h.title, details: h.details, dueOn: iso(h.dueOn) }} minDue={overdue ? iso(h.dueOn) : data.today} maxDue={data.section.sessionEnd} />
                              </div>
                            </details>
                            <ConfirmAction label="Remove" variant="destructive" icon={<Trash2 aria-hidden="true" />} title={`Remove "${h.title}"?`} description="It disappears from this list." confirmLabel="Remove" action={removeHomeworkAction} fields={{ id: h.id, version: String(h.version) }} />
                            <details className="w-full rounded-lg border p-3 open:pb-4">
                              <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium pointer-fine:min-h-9">
                                <Paperclip className="size-4" aria-hidden="true" /> {h.attachment ? "Replace or remove the attachment" : "Attach a file"}
                              </summary>
                              <form method="post" encType="multipart/form-data" action={`/api/v1/academic/homework/${h.id}/attachment`} className="mt-3 grid gap-2">
                                <input type="hidden" name="version" value={String(h.version)} />
                                <input type="hidden" name="section" value={data.section.id} />
                                <label htmlFor={`hw-file-${h.id}`} className="text-sm font-medium">
                                  PDF, JPEG or PNG, up to 10 MB
                                </label>
                                <input id={`hw-file-${h.id}`} name="file" type="file" required accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" className="min-h-11 rounded-lg border border-input p-2 text-sm" />
                                <Button type="submit" variant="outline" className="min-h-11 justify-self-start">
                                  Upload
                                </Button>
                              </form>
                              {h.attachment && (
                                <div className="mt-3">
                                  <ConfirmAction label="Remove attachment" variant="destructive" icon={<Trash2 aria-hidden="true" />} title="Remove the attachment?" description={`${h.attachment.name} is removed from this homework.`} confirmLabel="Remove" action={removeHomeworkAttachmentAction} fields={{ id: h.id, version: String(h.version) }} />
                                </div>
                              )}
                            </details>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
