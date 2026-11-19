import { UserMinus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listAllocatableTeachers, listSectionAllocations } from "@/modules/academic/allocations.service";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { removeAllocationAction } from "../actions";
import { AssignTeacherForm } from "./assign-form";

export const metadata = { title: "Subject teachers" };

const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;
const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function AllocationsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "academic.read") || scopeFor(ctx, "academic.read") !== "ALL") return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === pick("session")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];

  const header = (
    <>
      <PageHeader title="Subject teachers" description="Who teaches each subject in each section. A teacher must be an active teaching staff member with a linked login." />
      <AcademicTabs current="allocations" showClasses showSubjects />
    </>
  );
  if (!session || !section) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : "This session has no sections yet. Add sections first."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const writable = canManage && isSessionWritable(session.status);
  const [data, teachers] = await Promise.all([
    listSectionAllocations(ctx, { sectionId: section.id }),
    writable ? listAllocatableTeachers(ctx) : Promise.resolve([]),
  ]);
  const teacherOptions = teachers.map((t) => ({ value: t.id, label: `${t.fullName} (${t.employeeCode}) · ${t.designation.name}` }));
  const allocated = data.items.filter((i) => i.allocation).length;

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="al-session">
          Academic session
          <select id="al-session" name="session" defaultValue={session.id} className={FIELD}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({STATUS_LABEL[s.status]})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="al-section">
          Section
          <select id="al-section" name="section" defaultValue={section.id} className={FIELD}>
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
      {session.status === "CLOSED" && <p className="rounded-lg border p-3 text-sm">{session.name} is closed: allocations can only be removed.</p>}
      {writable && teacherOptions.length === 0 && (
        <p className="rounded-lg border p-3 text-sm">No teacher can be allocated yet: teachers need an active teaching staff record with a linked login (Staff → employee → Login account).</p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>
              {data.section.code} · {session.name}
            </h2>
          </CardTitle>
          <CardDescription>
            {data.items.length === 0 ? "This class has no subjects in this session yet (Class subjects tab)." : `${allocated} of ${data.items.length} subjects have a teacher.`}
          </CardDescription>
        </CardHeader>
        {data.items.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {data.items.map((i) => (
                <li key={i.classSubjectId} className="grid gap-2 rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium">
                      {i.subject.name} <span className="font-mono text-xs text-muted-foreground">{i.subject.code}</span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {i.isOptional && <Badge variant="outline">Optional</Badge>}
                      {!i.allocation && <Badge variant="secondary">No teacher</Badge>}
                      {i.allocation && !i.allocation.current && <Badge variant="destructive">Teacher no longer active</Badge>}
                    </span>
                  </div>
                  {i.allocation && (
                    <p>
                      {i.allocation.fullName} <span className="font-mono text-xs text-muted-foreground">{i.allocation.employeeCode}</span>
                    </p>
                  )}
                  {writable && teacherOptions.length > 0 && (
                    <AssignTeacherForm
                      sectionId={data.section.id}
                      classSubjectId={i.classSubjectId}
                      version={i.allocation?.version ?? null}
                      currentEmployeeId={i.allocation?.employeeId ?? null}
                      teachers={teacherOptions}
                      idPrefix="al"
                    />
                  )}
                  {canManage && i.allocation && (
                    <ConfirmAction
                      label="Remove teacher"
                      icon={<UserMinus aria-hidden="true" />}
                      variant="destructive"
                      title={`Remove ${i.allocation.fullName} from ${i.subject.name} in ${data.section.code}?`}
                      description="Not possible while the timetable names this teacher for this subject."
                      confirmLabel="Remove"
                      action={removeAllocationAction}
                      fields={{ id: i.allocation.id, version: String(i.allocation.version) }}
                    />
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
