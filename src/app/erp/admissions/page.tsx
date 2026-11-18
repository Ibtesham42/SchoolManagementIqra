import Link from "next/link";
import { Plus } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { formatDateOnly } from "@/lib/format";
import { listApplicationsSchema } from "@/modules/admissions/admissions.schemas";
import { STATUS_LABEL, type AdmissionStatus } from "@/modules/admissions/admissions.rules";
import { applicationFilterOptions, countApplicationsByStatus, listApplications } from "@/modules/admissions/admissions.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StatusBadge } from "./parts";

export const metadata = { title: "Admissions" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);

export default async function AdmissionsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "admission.read")) return <NotPermitted />;
  const sp = await searchParams;
  // Malformed query parameters fall back to defaults instead of an error page (A18).
  const parsed = listApplicationsSchema.safeParse({
    academicSessionId: one(sp.session),
    classId: one(sp.class),
    status: one(sp.status),
    q: one(sp.q),
    page: one(sp.page) ?? 1,
  });
  const filters = parsed.success ? parsed.data : listApplicationsSchema.parse({});
  const [{ total, rows, page, pageSize }, counts, options] = await Promise.all([
    listApplications(ctx, filters),
    countApplicationsByStatus(ctx, filters.academicSessionId),
    applicationFilterOptions(ctx),
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const canCreate = hasPermission(ctx, "admission.create");
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (filters.academicSessionId) u.set("session", filters.academicSessionId);
    if (filters.classId) u.set("class", filters.classId);
    if (filters.status) u.set("status", filters.status);
    if (filters.q) u.set("q", filters.q);
    u.set("page", String(p));
    return `/erp/admissions?${u.toString()}`;
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Admissions"
        description="Applications from draft to decision. Only an approved application creates a student record."
        actions={
          canCreate ? (
            <Button asChild className="w-full sm:w-auto">
              <Link href="/erp/admissions/new">
                <Plus aria-hidden="true" /> New admission
              </Link>
            </Button>
          ) : undefined
        }
      />
      {one(sp.deleted) && (
        <Alert role="status">
          <AlertDescription>Draft deleted.</AlertDescription>
        </Alert>
      )}

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Applications by status">
        {(Object.keys(counts) as AdmissionStatus[]).map((s) => (
          <li key={s}>
            <Link href={`/erp/admissions?status=${s}${filters.academicSessionId ? `&session=${filters.academicSessionId}` : ""}`} className="flex min-h-11 flex-col rounded-lg border p-3 hover:bg-muted">
              <span className="text-2xl font-semibold">{counts[s]}</span>
              <span className="text-xs text-muted-foreground">{STATUS_LABEL[s]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-5 lg:items-end">
        <TextField label="Search" name="q" defaultValue={filters.q ?? ""} placeholder="Name or application no." />
        <SelectField label="Session" name="session" options={[{ value: "", label: "All sessions" }, ...options.sessions.map((s) => ({ value: s.id, label: s.name }))]} defaultValue={filters.academicSessionId ?? ""} />
        <SelectField label="Class" name="class" options={[{ value: "", label: "All classes" }, ...options.classes.map((c) => ({ value: c.id, label: c.name }))]} defaultValue={filters.classId ?? ""} />
        <SelectField label="Status" name="status" options={[{ value: "", label: "All statuses" }, ...(Object.keys(STATUS_LABEL) as AdmissionStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))]} defaultValue={filters.status ?? ""} />
        <Button type="submit" variant="outline" className="w-full">
          Apply filters
        </Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Applications</h2>
          </CardTitle>
          <CardDescription>{total === 0 ? "No applications match." : `${total} application${total === 1 ? "" : "s"} · page ${page} of ${pages}`}</CardDescription>
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Application</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Applicant</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Class · session</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <td className="py-3 pr-3 font-mono text-xs">
                      <Link href={`/erp/admissions/${a.id}`} className="underline-offset-4 hover:underline">
                        {a.applicationNo ?? "Draft"}
                      </Link>
                    </td>
                    <td className="py-3 pr-3">
                      <Link href={`/erp/admissions/${a.id}`} className="font-medium underline-offset-4 hover:underline">
                        {a.fullName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">Born {formatDateOnly(a.dob)}</span>
                    </td>
                    <td className="py-3 pr-3">
                      {a.class.name}
                      {a.section ? ` · ${a.section.name}` : ""} <span className="text-muted-foreground">({a.academicSession.name})</span>
                    </td>
                    <td className="py-3 pr-3">
                      <StatusBadge status={a.status} />
                    </td>
                    <td className="py-3">{formatDateOnly(a.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {rows.map((a) => (
                <li key={a.id}>
                  <Link href={`/erp/admissions/${a.id}`} className="grid min-h-11 gap-1 rounded-lg border p-3 hover:bg-muted">
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{a.fullName}</span>
                      <StatusBadge status={a.status} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {a.applicationNo ?? "Draft"} · {a.class.name} · {a.academicSession.name}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <nav aria-label="Pages" className="mt-4 flex justify-between gap-2">
                {page > 1 ? (
                  <Button asChild variant="outline">
                    <Link href={qs(page - 1)}>Previous</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {page < pages && (
                  <Button asChild variant="outline">
                    <Link href={qs(page + 1)}>Next</Link>
                  </Button>
                )}
              </nav>
            )}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
