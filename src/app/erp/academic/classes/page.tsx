import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { listClasses } from "@/modules/academic/classes.service";
import { getDefaultSectionCapacity } from "@/modules/academic/sections.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { setClassActiveAction } from "../actions";
import { ClassForm } from "./class-form";

export const metadata = { title: "Classes" };

type ClassItem = Awaited<ReturnType<typeof listClasses>>[number];

const levelLabel = (n: number) => (n > 0 ? String(n) : `${n} (pre-primary)`);

function StatusBadge({ c }: { c: ClassItem }) {
  return <Badge variant={c.isActive ? "default" : "secondary"}>{c.isActive ? "Active" : "Inactive"}</Badge>;
}

function ClassActions({ c, schoolDefault, view }: { c: ClassItem; schoolDefault: number; view: "t" | "c" }) {
  return (
    <div className="grid gap-2">
      <details className="rounded-lg border p-3 open:pb-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit {c.name}</summary>
        <div className="mt-3">
          <ClassForm
            idPrefix={view}
            schoolDefaultCapacity={schoolDefault}
            defaults={{
              id: c.id,
              version: c.version,
              code: c.code,
              name: c.name,
              numericLevel: String(c.numericLevel),
              displayOrder: String(c.displayOrder),
              defaultSectionCapacity: c.defaultSectionCapacity === null ? "" : String(c.defaultSectionCapacity),
              codeLocked: c._count.sections > 0,
            }}
          />
        </div>
      </details>
      {c.isActive ? (
        <ConfirmAction
          label="Deactivate"
          icon={<CircleOff aria-hidden="true" />}
          variant="destructive"
          title={`Deactivate ${c.name}?`}
          description="No new sections can be added to an inactive class. Its existing sections, in every session, are not changed."
          confirmLabel="Deactivate"
          action={setClassActiveAction}
          fields={{ id: c.id, version: String(c.version), active: "false" }}
        />
      ) : (
        <ConfirmAction
          label="Activate"
          icon={<CheckCircle2 aria-hidden="true" />}
          title={`Activate ${c.name}?`}
          description="Sections can be added to this class again."
          confirmLabel="Activate"
          action={setClassActiveAction}
          fields={{ id: c.id, version: String(c.version), active: "true" }}
        />
      )}
    </div>
  );
}

export default async function ClassesPage() {
  const ctx = await requireAuth();
  // The class master list is for school-wide readers (academic.read ALL); teachers see their own section(s)
  // instead. academic.manage alone is not enough: listing needs academic.read.
  if (!hasPermission(ctx, "academic.read") || scopeFor(ctx, "academic.read") !== "ALL") return <NotPermitted />;
  const canManage = hasPermission(ctx, "academic.manage");
  const [classes, schoolDefault] = await Promise.all([listClasses(ctx, { includeInactive: true }), canManage ? getDefaultSectionCapacity(ctx) : Promise.resolve(0)]);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Classes" description="The school's classes, used in every academic session. Streams are separate classes, e.g. Class 11 Science and Class 11 Commerce. Classes are never deleted — deactivate one that is no longer offered." />
      <AcademicTabs current="classes" showClasses showSubjects />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>All classes</h2>
          </CardTitle>
          <CardDescription>{classes.length === 0 ? "No classes yet." : `${classes.length} class${classes.length === 1 ? "" : "es"}.`}</CardDescription>
        </CardHeader>
        {classes.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Class</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Code</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Level</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Default capacity</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  {canManage && <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {classes.map((c) => (
                  <tr key={c.id} className="border-b align-top last:border-0">
                    <td className="py-3 pr-3 font-medium">{c.name}</td>
                    <td className="py-3 pr-3 font-mono">{c.code}</td>
                    <td className="py-3 pr-3">{levelLabel(c.numericLevel)}</td>
                    <td className="py-3 pr-3">{c.defaultSectionCapacity ?? `School default${canManage ? ` (${schoolDefault})` : ""}`}</td>
                    <td className="py-3 pr-3"><StatusBadge c={c} /></td>
                    {canManage && (
                      <td className="w-72 py-3">
                        <ClassActions c={c} schoolDefault={schoolDefault} view="t" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {classes.map((c) => (
                <li key={c.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{c.name}</span>
                    <StatusBadge c={c} />
                  </div>
                  <dl className="grid grid-cols-2 gap-1 text-sm">
                    <dt className="text-muted-foreground">Code</dt>
                    <dd className="font-mono">{c.code}</dd>
                    <dt className="text-muted-foreground">Level</dt>
                    <dd>{levelLabel(c.numericLevel)}</dd>
                    <dt className="text-muted-foreground">Default capacity</dt>
                    <dd>{c.defaultSectionCapacity ?? "School default"}</dd>
                  </dl>
                  {canManage && <ClassActions c={c} schoolDefault={schoolDefault} view="c" />}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>New class</h2>
            </CardTitle>
            <CardDescription>Add each class once. Sections are created per academic session on the Sections tab.</CardDescription>
          </CardHeader>
          <CardContent>
            <ClassForm schoolDefaultCapacity={schoolDefault} defaults={{ code: "", name: "", numericLevel: "", displayOrder: String(classes.length * 10), defaultSectionCapacity: "" }} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
