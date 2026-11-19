import { CheckCircle2, CircleOff, Lock, Trash2, UserMinus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listClasses } from "@/modules/academic/classes.service";
import { getDefaultSectionCapacity, listEligibleClassTeachers, listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { SelectField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { deleteSectionAction, setSectionActiveAction, unassignClassTeacherAction } from "../actions";
import { AddSectionsForm, AssignTeacherForm, CopySectionsForm, EditSectionForm } from "./section-forms";

export const metadata = { title: "Sections" };

type Section = Awaited<ReturnType<typeof listSections>>[number];
const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;

function SectionManage({ s, teachers }: { s: Section; teachers: { value: string; label: string }[] }) {
  const ref = { id: s.id, version: String(s.version) };
  return (
    <div className="grid gap-2 sm:col-span-full">
      <details className="rounded-lg border p-3">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Manage {s.code}</summary>
        <div className="mt-3 grid gap-4">
          {/* Only the fields each client form needs cross to the browser. */}
          <EditSectionForm section={{ id: s.id, version: s.version, name: s.name, capacity: s.capacity }} />
          <AssignTeacherForm section={{ id: s.id, version: s.version, classTeacherId: s.classTeacherId }} teachers={teachers} />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {s.classTeacherId && (
              <ConfirmAction
                label="Remove class teacher"
                icon={<UserMinus aria-hidden="true" />}
                title={`Remove the class teacher of ${s.code}?`}
                description="The teacher loses access to this section's records that came from being its class teacher."
                confirmLabel="Remove"
                action={unassignClassTeacherAction}
                fields={ref}
              />
            )}
            {s.isActive ? (
              <ConfirmAction
                label="Deactivate"
                icon={<CircleOff aria-hidden="true" />}
                variant="destructive"
                title={`Deactivate ${s.code}?`}
                description="An inactive section accepts no new enrolments. Nothing already recorded is changed."
                confirmLabel="Deactivate"
                action={setSectionActiveAction}
                fields={{ ...ref, active: "false" }}
              />
            ) : (
              <ConfirmAction
                label="Activate"
                icon={<CheckCircle2 aria-hidden="true" />}
                title={`Activate ${s.code}?`}
                description="The section accepts enrolments again."
                confirmLabel="Activate"
                action={setSectionActiveAction}
                fields={{ ...ref, active: "true" }}
              />
            )}
            <ConfirmAction
              label="Delete"
              icon={<Trash2 aria-hidden="true" />}
              variant="destructive"
              title={`Delete ${s.code}?`}
              description="Only possible while no student or record uses this section. This can't be undone; deactivate instead to keep its history."
              confirmLabel="Delete section"
              action={deleteSectionAction}
              fields={ref}
            />
          </div>
        </div>
      </details>
    </div>
  );
}

export default async function SectionsPage({ searchParams }: { searchParams: Promise<{ session?: string | string[] }> }) {
  const ctx = await requireAuth();
  const scope = hasPermission(ctx, "academic.read") ? scopeFor(ctx, "academic.read") : null;
  if (scope !== "ALL" && scope !== "ASSIGNED") return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");

  const { sessions, currentId } = await listSessionsForSections(ctx);
  const requested = (await searchParams).session;
  const requestedId = typeof requested === "string" ? requested : undefined;
  const session = sessions.find((s) => s.id === requestedId) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];

  const header = (
    <>
      <PageHeader
        title="Sections"
        description={scope === "ALL" ? "Sections belong to one academic session. Capacity is the most students a section can hold." : "The section(s) you are class teacher of."}
      />
      <AcademicTabs current="sections" showClasses={scope === "ALL"} showSubjects={scope === "ALL"} />
    </>
  );
  if (!session) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>No academic session exists yet. Create one in Settings › Academic sessions first.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const writable = canManage && isSessionWritable(session.status);
  const [sections, classes, teachers, schoolDefault] = await Promise.all([
    listSections(ctx, { academicSessionId: session.id }),
    writable ? listClasses(ctx) : Promise.resolve([]),
    writable ? listEligibleClassTeachers(ctx) : Promise.resolve([]),
    writable ? getDefaultSectionCapacity(ctx) : Promise.resolve(0),
  ]);
  const teacherOptions = teachers.map((t) => ({ value: t.id, label: t.displayName }));
  const groups = new Map<string, { name: string; sections: Section[] }>();
  for (const s of sections) {
    const g = groups.get(s.classId) ?? { name: s.class.name, sections: [] };
    g.sections.push(s);
    groups.set(s.classId, g);
  }
  const copySources = sessions.filter((s) => s.id !== session.id).map((s) => ({ value: s.id, label: `${s.name} (${STATUS_LABEL[s.status]})` }));

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}

      {/* Session switcher: a plain GET form, so it works before JavaScript loads. */}
      <form method="get" className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="sm:w-72">
          <SelectField
            label="Academic session"
            name="session"
            defaultValue={session.id}
            options={sessions.map((s) => ({ value: s.id, label: `${s.name} · ${STATUS_LABEL[s.status]}${s.id === currentId ? " · current" : ""}` }))}
          />
        </div>
        <Button type="submit" variant="outline" className="w-full sm:w-auto">
          Show
        </Button>
      </form>

      {session.status === "CLOSED" && (
        <Alert>
          <Lock aria-hidden="true" />
          <AlertDescription>
            Session {session.name} is closed. Its sections are read-only; class teachers no longer have access through them{canManage ? " and can be removed here" : ""}.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Sections in {session.name}</h2>
          </CardTitle>
          <CardDescription>
            {sections.length === 0 ? (scope === "ALL" ? "No sections in this session yet." : "You are not class teacher of a section in this session.") : `${sections.length} section${sections.length === 1 ? "" : "s"} in ${groups.size} class${groups.size === 1 ? "" : "es"}.`}
          </CardDescription>
        </CardHeader>
        {sections.length > 0 && (
          <CardContent className="grid gap-6">
            {[...groups.entries()].map(([classId, g]) => (
              <section key={classId} aria-labelledby={`class-${classId}`} className="grid gap-2">
                <h3 id={`class-${classId}`} className="text-base font-semibold">
                  {g.name}
                </h3>
                <ul className="grid gap-3">
                  {g.sections.map((s) => (
                    <li key={s.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-4 sm:items-start">
                      <div className="flex items-start justify-between gap-2 sm:block">
                        <p className="font-medium">Section {s.name}</p>
                        <p className="font-mono text-xs text-muted-foreground">{s.code}</p>
                      </div>
                      <p className="text-sm">
                        <span className="text-muted-foreground">Capacity </span>
                        {s.capacity}
                      </p>
                      <p className="text-sm">
                        <span className="text-muted-foreground">Class teacher </span>
                        {s.classTeacher?.displayName ?? "Not assigned"}
                      </p>
                      <div>
                        <Badge variant={s.isActive ? "default" : "secondary"}>{s.isActive ? "Active" : "Inactive"}</Badge>
                      </div>
                      {writable && <SectionManage s={s} teachers={teacherOptions} />}
                      {/* S-02: a closed session stays read-only, but its class-teacher access can still be removed. */}
                      {!writable && canManage && s.classTeacherId && (
                        <div className="sm:col-span-full">
                          <ConfirmAction
                            label="Remove class teacher"
                            icon={<UserMinus aria-hidden="true" />}
                            title={`Remove the class teacher of ${s.code}?`}
                            description="The session is closed; removing the class teacher ends any access that came from this assignment. Nothing else in the section changes."
                            confirmLabel="Remove"
                            action={unassignClassTeacherAction}
                            fields={{ id: s.id, version: String(s.version) }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </CardContent>
        )}
      </Card>

      {writable && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Add sections</h2>
              </CardTitle>
              <CardDescription>
                {classes.length === 0 ? "Add classes on the Classes tab first." : `Creates sections of one class in ${session.name}. Codes are made from the class code and the name, e.g. C06-A.`}
              </CardDescription>
            </CardHeader>
            {classes.length > 0 && (
              <CardContent>
                <AddSectionsForm sessionId={session.id} classes={classes.map((c) => ({ value: c.id, label: `${c.name} (${c.code})` }))} schoolDefaultCapacity={schoolDefault} />
              </CardContent>
            )}
          </Card>
          {copySources.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Copy from another session</h2>
                </CardTitle>
                <CardDescription>Start a new year with last year&apos;s sections. Safe to run again: nothing is duplicated.</CardDescription>
              </CardHeader>
              <CardContent>
                <CopySectionsForm toSessionId={session.id} sources={copySources} />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
