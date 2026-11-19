import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { listSubjects } from "@/modules/academic/subjects.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { setSubjectActiveAction } from "../actions";
import { SubjectForm } from "./subject-form";

export const metadata = { title: "Subjects" };

type SubjectItem = Awaited<ReturnType<typeof listSubjects>>[number];
const KIND = { SCHOLASTIC: "Scholastic", CO_SCHOLASTIC: "Co-scholastic" } as const;

function StatusBadge({ s }: { s: SubjectItem }) {
  return <Badge variant={s.isActive ? "default" : "secondary"}>{s.isActive ? "Active" : "Inactive"}</Badge>;
}

function SubjectActions({ s, view }: { s: SubjectItem; view: "t" | "c" }) {
  return (
    <div className="grid gap-2">
      <details className="rounded-lg border p-3 open:pb-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit {s.name}</summary>
        <div className="mt-3">
          <SubjectForm idPrefix={view} defaults={{ id: s.id, version: s.version, code: s.code, name: s.name, kind: s.kind, locked: s._count.classSubjects > 0 }} />
        </div>
      </details>
      <ConfirmAction
        label={s.isActive ? "Deactivate" : "Activate"}
        icon={s.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
        variant={s.isActive ? "destructive" : undefined}
        title={`${s.isActive ? "Deactivate" : "Activate"} ${s.name}?`}
        description={s.isActive ? "It can't be added to classes any more. Classes that already study it keep it." : "It can be added to classes again."}
        confirmLabel={s.isActive ? "Deactivate" : "Activate"}
        action={setSubjectActiveAction}
        fields={{ id: s.id, version: String(s.version), active: s.isActive ? "false" : "true" }}
      />
    </div>
  );
}

export default async function SubjectsPage() {
  const ctx = await requireAuth();
  // School-wide academic readers (ALL) see the subject list; academic.manage holders also edit it.
  if (!hasPermission(ctx, "academic.read") || scopeFor(ctx, "academic.read") !== "ALL") return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");
  const subjects = await listSubjects(ctx, { includeInactive: true });

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Subjects"
        description="The subjects the school teaches, in any language. They are added to classes per academic session. Never deleted — deactivate one that is no longer taught."
      />
      <AcademicTabs current="subjects" showClasses showSubjects />
      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a subject</h2>
            </CardTitle>
            <CardDescription>Nothing is pre-filled: add the subjects your school teaches.</CardDescription>
          </CardHeader>
          <CardContent>
            <SubjectForm defaults={{ code: "", name: "", kind: "SCHOLASTIC" }} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>All subjects</h2>
          </CardTitle>
          <CardDescription>{subjects.length === 0 ? "No subjects yet." : `${subjects.length} subject${subjects.length === 1 ? "" : "s"}.`}</CardDescription>
        </CardHeader>
        {subjects.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Subject</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Code</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Type</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Used by classes</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  {canManage && <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {subjects.map((s) => (
                  <tr key={s.id} className="border-b align-top last:border-0">
                    <td className="py-3 pr-3 font-medium">{s.name}</td>
                    <td className="py-3 pr-3 font-mono">{s.code}</td>
                    <td className="py-3 pr-3">{KIND[s.kind]}</td>
                    <td className="py-3 pr-3">{s._count.classSubjects > 0 ? "Yes" : "No"}</td>
                    <td className="py-3 pr-3"><StatusBadge s={s} /></td>
                    {canManage && (
                      <td className="w-72 py-3">
                        <SubjectActions s={s} view="t" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {subjects.map((s) => (
                <li key={s.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{s.name}</span>
                    <StatusBadge s={s} />
                  </div>
                  <dl className="grid grid-cols-2 gap-1 text-sm">
                    <dt className="text-muted-foreground">Code</dt>
                    <dd className="font-mono">{s.code}</dd>
                    <dt className="text-muted-foreground">Type</dt>
                    <dd>{KIND[s.kind]}</dd>
                  </dl>
                  {canManage && <SubjectActions s={s} view="c" />}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
