import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { isSessionWritable } from "@/modules/academic/academic.rules";
import { listSections, listSessionsForSections } from "@/modules/academic/sections.service";
import { getSectionChoices } from "@/modules/students/subject-choices.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { academicTabFlags } from "../tab-flags";
import { SubjectChoicesForm } from "./choices-form";

export const metadata = { title: "Optional subjects" };

const STATUS_LABEL = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" } as const;
const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function OptionalSubjectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const all = (k: "academic.read" | "student.read") => hasPermission(ctx, k) && scopeFor(ctx, k) === "ALL";
  if (!all("academic.read") || !all("student.read")) return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");
  const sp = await searchParams;
  const pick = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);

  const { sessions, currentId } = await listSessionsForSections(ctx);
  const session = sessions.find((s) => s.id === pick("session")) ?? sessions.find((s) => s.id === currentId) ?? sessions[0];
  const sections = session ? await listSections(ctx, { academicSessionId: session.id }) : [];
  const section = sections.find((s) => s.id === pick("section")) ?? sections[0];

  const header = (
    <>
      <PageHeader title="Optional subjects" description="Which students take each optional subject, section by section." />
      <AcademicTabs current="optional-subjects" {...academicTabFlags(ctx)} />
    </>
  );
  if (!session || !section) {
    return (
      <div className="mx-auto grid max-w-4xl gap-4">
        {header}
        <Alert>
          <AlertDescription>{!session ? "No academic session exists yet." : "This session has no sections yet."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const data = await getSectionChoices(ctx, { sectionId: section.id });
  const subject = data.subjects.find((s) => s.id === pick("subject")) ?? data.subjects[0];
  const writable = canManage && isSessionWritable(session.status);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      {header}
      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="os-session">
          Academic session
          <select id="os-session" name="session" defaultValue={session.id} className={FIELD}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({STATUS_LABEL[s.status]})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="os-section">
          Section
          <select id="os-section" name="section" defaultValue={section.id} className={FIELD}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-medium" htmlFor="os-subject">
          Optional subject
          <select id="os-subject" name="subject" defaultValue={subject?.id ?? ""} className={FIELD}>
            {data.subjects.length === 0 && <option value="">None</option>}
            {data.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" className="min-h-11">
          Show
        </Button>
      </form>
      {session.status === "CLOSED" && <p className="rounded-lg border p-3 text-sm">{session.name} is closed: choices are read-only.</p>}

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{subject ? `${subject.name} · ${data.section.code}` : data.section.code}</h2>
          </CardTitle>
          <CardDescription>
            {!subject
              ? "This class has no optional subjects in this session (Class subjects tab)."
              : data.roster.length === 0
                ? "No students are enrolled in this section yet."
                : `${subject.chosen.length} of ${data.roster.length} students take it.`}
          </CardDescription>
        </CardHeader>
        {subject && data.roster.length > 0 && (
          <CardContent>
            <SubjectChoicesForm
              key={`${data.section.id}|${subject.id}`}
              sectionId={data.section.id}
              classSubjectId={subject.id}
              roster={data.roster}
              chosen={subject.chosen}
              disabled={!writable}
            />
          </CardContent>
        )}
      </Card>
    </div>
  );
}
