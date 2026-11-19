import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { gradingAccess, listScales } from "@/modules/academic/grading.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { AcademicTabs } from "../academic-tabs";
import { setScaleActiveAction } from "../actions";
import { ScaleForm } from "./scale-form";
import { TemplateButton } from "./template-button";

export const metadata = { title: "Grading scales" };

type Scale = Awaited<ReturnType<typeof listScales>>[number];
const num = (v: { toString(): string } | null) => (v === null ? "" : String(Number(v.toString())));

function Bands({ s }: { s: Scale }) {
  return (
    <ul className="grid gap-1 text-sm">
      {s.bands.map((b, i) => {
        const next = s.bands[i + 1];
        return (
          <li key={b.grade} className="flex flex-wrap justify-between gap-2">
            <span>
              {num(b.minPercent)} %{next ? ` to below ${num(next.minPercent)} %` : " and above"}
            </span>
            <span className="font-medium">
              {b.grade}
              {b.gradePoint !== null && ` (${num(b.gradePoint)})`}
              {b.remark && <span className="font-normal text-muted-foreground"> · {b.remark}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export default async function GradingPage() {
  const ctx = await requireAuth();
  const access = gradingAccess(ctx);
  if (!access.read) return <NotPermitted />;
  const scales = await listScales(ctx);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Grading scales"
        description="How percentages become grades on results and report cards. Nothing is pre-filled: define your school's scale, or start from a template and edit it."
      />
      <AcademicTabs current="grading" showClasses showSubjects />
      {access.manage && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Add a grading scale</h2>
            </CardTitle>
            <CardDescription>Once an exam uses a scale, its bands are fixed so published grades never change.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <TemplateButton />
            <ScaleForm defaults={{ name: "", bands: [] }} />
          </CardContent>
        </Card>
      )}
      {scales.length === 0 ? (
        <p className="text-sm text-muted-foreground">No grading scales yet.</p>
      ) : (
        scales.map((s) => {
          const locked = s._count.examinations > 0;
          return (
            <Card key={s.id}>
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center justify-between gap-2">
                  <h2>{s.name}</h2>
                  <Badge variant={s.isActive ? "default" : "secondary"}>{s.isActive ? "Active" : "Inactive"}</Badge>
                </CardTitle>
                <CardDescription>{locked ? "Used by exams — bands fixed." : "Not used by any scheduled exam yet."}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-3">
                <Bands s={s} />
                {access.manage && (
                  <>
                    <details className="rounded-lg border p-3 open:pb-4">
                      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit {s.name}</summary>
                      <div className="mt-3">
                        <ScaleForm
                          defaults={{
                            id: s.id,
                            version: s.version,
                            name: s.name,
                            locked,
                            bands: s.bands.map((b) => ({ minPercent: num(b.minPercent), grade: b.grade, gradePoint: num(b.gradePoint), remark: b.remark ?? "" })),
                          }}
                        />
                      </div>
                    </details>
                    <ConfirmAction
                      label={s.isActive ? "Deactivate" : "Activate"}
                      icon={s.isActive ? <CircleOff aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
                      variant={s.isActive ? "destructive" : undefined}
                      title={`${s.isActive ? "Deactivate" : "Activate"} ${s.name}?`}
                      description={s.isActive ? "New exams can't use it. Exams that already use it keep it." : "New exams can use it again."}
                      confirmLabel={s.isActive ? "Deactivate" : "Activate"}
                      action={setScaleActiveAction}
                      fields={{ id: s.id, version: String(s.version), active: s.isActive ? "false" : "true" }}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
