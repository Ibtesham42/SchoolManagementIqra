import { Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listClassSubjects } from "@/modules/academic/class-subjects.service";
import { listClasses } from "@/modules/academic/classes.service";
import { listSessionsForSections } from "@/modules/academic/sections.service";
import { listSubjects } from "@/modules/academic/subjects.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { academicTabFlags } from "../tab-flags";
import { removeClassSubjectAction } from "../actions";
import { AddClassSubjectsForm, CopyClassSubjectsForm, EditClassSubjectForm } from "./class-subject-forms";

export const metadata = { title: "Class subjects" };

const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;
const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function ClassSubjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "academic.read") || scopeFor(ctx, "academic.read") !== "ALL") return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const [{ sessions, currentId }, classes] = await Promise.all([listSessionsForSections(ctx), listClasses(ctx)]);
  const session = sessions.find((s) => s.id === pick("session")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const cls = classes.find((c) => c.id === pick("class")) ?? classes[0];

  const header = (
    <>
      <PageHeader title="Class subjects" description="What each class studies in an academic session. Optional subjects are chosen per student." />
      <AcademicTabs current="class-subjects" {...academicTabFlags(ctx)} />
    </>
  );
  if (!session || !cls) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet. Create one in Settings first." : "No active class exists yet. Add classes first."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const data = await listClassSubjects(ctx, { academicSessionId: session.id, classId: cls.id });
  const writable = canManage && isSessionWritable(session.status);
  const mapped = new Set(data.items.map((i) => i.subject.id));
  const available = writable
    ? (await listSubjects(ctx)).filter((s) => !mapped.has(s.id)).map((s) => ({ id: s.id, label: `${s.name} (${s.code})` }))
    : [];
  const copySources = sessions.filter((s) => s.id !== session.id).map((s) => ({ value: s.id, label: `${s.name} (${STATUS_LABEL[s.status]})` }));

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}
      {/* Plain GET form: works before JavaScript loads. */}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="cs-session">
          Academic session
          <select id="cs-session" name="session" defaultValue={session.id} className={FIELD}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({STATUS_LABEL[s.status]})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="cs-class">
          Class
          <select id="cs-class" name="class" defaultValue={cls.id} className={FIELD}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      {session.status === "CLOSED" && <p className="rounded-lg border p-3 text-sm">{session.name} is closed: its class subjects are read-only.</p>}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              {cls.name} · {session.name}
            </h2>
          </CardTitle>
          <CardDescription>
            {data.items.length === 0
              ? "No subjects yet."
              : `${data.items.length} subject${data.items.length === 1 ? "" : "s"} · ${data.items.filter((i) => i.isOptional).length} optional`}
          </CardDescription>
        </CardHeader>
        {data.items.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {data.items.map((i) => {
                const used = i._count.studentChoices + i._count.allocations + i._count.timetableSlots;
                return (
                  <li key={i.id} className="grid gap-2 rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <span className="font-medium">
                        {i.subject.name} <span className="font-mono text-xs text-muted-foreground">{i.subject.code}</span>
                      </span>
                      <span className="flex flex-wrap gap-1">
                        <Badge variant={i.isOptional ? "outline" : "default"}>{i.isOptional ? "Optional" : "Compulsory"}</Badge>
                        {i.subject.kind === "CO_SCHOLASTIC" && <Badge variant="secondary">Co-scholastic</Badge>}
                        {!i.subject.isActive && <Badge variant="secondary">Subject inactive</Badge>}
                      </span>
                    </div>
                    {i.isOptional && <p className="text-muted-foreground">{i._count.studentChoices} student(s) chose it.</p>}
                    {writable && (
                      <div className="grid gap-2">
                        <details className="rounded-lg border p-3">
                          <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">Edit</summary>
                          <div className="mt-3">
                            <EditClassSubjectForm row={{ id: i.id, version: i.version, isOptional: i.isOptional, sortOrder: i.sortOrder }} idPrefix="cs" />
                          </div>
                        </details>
                        {used === 0 && (
                          <ConfirmAction
                            label="Remove from class"
                            icon={<Trash2 aria-hidden="true" />}
                            variant="destructive"
                            title={`Remove ${i.subject.name} from ${cls.name}?`}
                            description="Only possible while no student choice, teacher allocation or timetable slot uses it."
                            confirmLabel="Remove"
                            action={removeClassSubjectAction}
                            fields={{ id: i.id, version: String(i.version) }}
                          />
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </CardContent>
        )}
      </Card>

      {writable && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add subjects to {cls.name}</h2>
            </CardTitle>
            <CardDescription>{available.length === 0 ? "Every active subject is already in this class." : "Only active subjects are listed."}</CardDescription>
          </CardHeader>
          {available.length > 0 && (
            <CardContent>
              <AddClassSubjectsForm key={`${session.id}|${cls.id}`} academicSessionId={session.id} classId={cls.id} available={available} />
            </CardContent>
          )}
        </Card>
      )}
      {writable && copySources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Copy from another session</h2>
            </CardTitle>
            <CardDescription>Copies every active class&apos;s active subjects into {session.name}. Subjects a class already has are kept.</CardDescription>
          </CardHeader>
          <CardContent>
            <CopyClassSubjectsForm toSessionId={session.id} sources={copySources} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
