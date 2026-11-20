import { Trash2 } from "lucide-react";
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
import { removeHomeworkAction } from "../actions";
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

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Homework" description="Homework for each section and subject. Students and parents will see it once the portal exists." />
      <AcademicTabs current="homework" {...academicTabFlags(ctx)} />
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
                        {h.canManage && !data.section.closed && (
                          <div className="flex flex-wrap items-start gap-2">
                            <details className="grow rounded-lg border p-3 open:pb-4">
                              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit</summary>
                              <div className="mt-3">
                                <HomeworkForm defaults={{ id: h.id, version: h.version, title: h.title, details: h.details, dueOn: iso(h.dueOn) }} minDue={overdue ? iso(h.dueOn) : data.today} maxDue={data.section.sessionEnd} />
                              </div>
                            </details>
                            <ConfirmAction label="Remove" variant="destructive" icon={<Trash2 aria-hidden="true" />} title={`Remove "${h.title}"?`} description="It disappears from this list." confirmLabel="Remove" action={removeHomeworkAction} fields={{ id: h.id, version: String(h.version) }} />
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
