import Link from "next/link";
import { Download } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission, scopeFor } from "@/lib/rbac/authorize";
import { EXPORT_MESSAGES, isExportCode } from "@/lib/http/export-errors";
import { listStudentsSchema } from "@/modules/students/students.schemas";
import { STUDENT_STATUS_LABEL, STUDENT_STATUSES } from "@/modules/students/students.rules";
import { canBrowseStudents, countStudentsByStatus, listStudents, studentFilterOptions } from "@/modules/students/students.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/erp/form";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { StudentStatusBadge } from "./parts";

export const metadata = { title: "Students" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
const ALL_SESSIONS = "all";

export default async function StudentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!canBrowseStudents(ctx)) return <NotPermitted />;
  const sp = await searchParams;

  // The session filter defaults to the school's current session; "all" shows every session.
  const base = await studentFilterOptions(ctx);
  const sessionParam = one(sp.session);
  const sessionId = sessionParam === ALL_SESSIONS ? undefined : (sessionParam ?? base.currentSessionId ?? undefined);
  const parsed = listStudentsSchema.safeParse({ academicSessionId: sessionId, classId: one(sp.class), sectionId: one(sp.section), status: one(sp.status), q: one(sp.q), page: one(sp.page) ?? 1 });
  const filters = parsed.success ? parsed.data : listStudentsSchema.parse({});
  const [{ total, rows, page, pageSize }, counts, options] = await Promise.all([
    listStudents(ctx, filters),
    countStudentsByStatus(ctx, filters.academicSessionId),
    filters.academicSessionId ? studentFilterOptions(ctx, filters.academicSessionId) : Promise.resolve(base),
  ]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const classTeacherView = scopeFor(ctx, "student.read") === "ASSIGNED";
  const canExport = hasPermission(ctx, "export.run") && scopeFor(ctx, "admission.read") === "ALL";
  const exportCode = one(sp.export);
  const sessionValue = filters.academicSessionId ?? ALL_SESSIONS;
  const sections = options.sections.filter((s) => !filters.classId || s.classId === filters.classId);

  const qs = (over: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    const v = { session: sessionValue, class: filters.classId, section: filters.sectionId, status: filters.status, q: filters.q, ...over };
    for (const [k, val] of Object.entries(v)) if (val) u.set(k, val);
    return `/erp/students?${u.toString()}`;
  };

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Students"
        description={classTeacherView ? "Students of the sections where you are the class teacher." : "Registered students. New students are added by approving an admission."}
      />
      {isExportCode(exportCode) && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{EXPORT_MESSAGES[exportCode]}</AlertDescription>
        </Alert>
      )}

      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Students by status">
        {STUDENT_STATUSES.map((s) => (
          <li key={s}>
            <Link href={qs({ status: s, page: undefined })} className="flex min-h-11 flex-col rounded-lg border p-3 hover:bg-muted">
              <span className="text-2xl font-semibold">{counts[s]}</span>
              <span className="text-xs text-muted-foreground">{STUDENT_STATUS_LABEL[s]}</span>
            </Link>
          </li>
        ))}
      </ul>

      <form method="get" className="grid gap-3 rounded-lg border p-3 sm:grid-cols-2 lg:grid-cols-3 lg:items-end">
        <div className="sm:col-span-2 lg:col-span-3">
          <TextField label="Search" name="q" defaultValue={filters.q ?? ""} placeholder="Name, student ID or admission no." />
        </div>
        <SelectField label="Session" name="session" options={[{ value: ALL_SESSIONS, label: "All sessions" }, ...options.sessions.map((s) => ({ value: s.id, label: s.name }))]} defaultValue={sessionValue} />
        <SelectField label="Class" name="class" options={[{ value: "", label: "All classes" }, ...options.classes.map((c) => ({ value: c.id, label: c.name }))]} defaultValue={filters.classId ?? ""} />
        <SelectField
          label="Section"
          name="section"
          options={[{ value: "", label: filters.academicSessionId ? "All sections" : "Choose a session first" }, ...sections.map((s) => ({ value: s.id, label: `${s.class.name} · ${s.name}` }))]}
          defaultValue={filters.sectionId ?? ""}
        />
        <SelectField label="Status" name="status" options={[{ value: "", label: "All statuses" }, ...STUDENT_STATUSES.map((s) => ({ value: s, label: STUDENT_STATUS_LABEL[s] }))]} defaultValue={filters.status ?? ""} />
        <Button type="submit" variant="outline" className="w-full lg:col-start-3">
          Apply filters
        </Button>
      </form>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1.5">
            <CardTitle>
              <h2>Directory</h2>
            </CardTitle>
            <CardDescription>{total === 0 ? "No students match." : `${total} student${total === 1 ? "" : "s"} · page ${page} of ${pages}`}</CardDescription>
          </div>
          {canExport && total > 0 && (
            // POST so the export route's same-origin check applies (audited personal-data export).
            <form method="post" action="/api/v1/students/export">
              {filters.academicSessionId && <input type="hidden" name="session" value={filters.academicSessionId} />}
              {filters.classId && <input type="hidden" name="class" value={filters.classId} />}
              {filters.sectionId && <input type="hidden" name="section" value={filters.sectionId} />}
              {filters.status && <input type="hidden" name="status" value={filters.status} />}
              {filters.q && <input type="hidden" name="q" value={filters.q} />}
              <Button type="submit" variant="outline" className="w-full sm:w-auto">
                <Download aria-hidden="true" /> Export CSV
              </Button>
            </form>
          )}
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Student</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Student ID</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Class · section</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Roll no.</th>
                  <th scope="col" className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <td className="py-3 pr-3">
                      <Link href={`/erp/students/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                        {s.fullName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">Adm. {s.admissionNo}</span>
                    </td>
                    <td className="py-3 pr-3 font-mono text-xs">{s.studentCode}</td>
                    <td className="py-3 pr-3">
                      {s.enrollment ? `${s.enrollment.section.class.name} · ${s.enrollment.section.name}` : "—"}
                      {s.enrollment && <span className="block text-xs text-muted-foreground">{s.enrollment.academicSession.name}</span>}
                    </td>
                    <td className="py-3 pr-3">{s.enrollment?.rollNumber?.rollNumber ?? "—"}</td>
                    <td className="py-3">
                      <StudentStatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {rows.map((s) => (
                <li key={s.id}>
                  <Link href={`/erp/students/${s.id}`} className="grid min-h-11 gap-1 rounded-lg border p-3 hover:bg-muted">
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-medium">{s.fullName}</span>
                      <StudentStatusBadge status={s.status} />
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {s.studentCode}
                      {s.enrollment ? ` · ${s.enrollment.section.class.name} ${s.enrollment.section.name}` : ""}
                      {s.enrollment?.rollNumber ? ` · Roll ${s.enrollment.rollNumber.rollNumber}` : ""}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <nav aria-label="Pages" className="mt-4 flex justify-between gap-2">
                {page > 1 ? (
                  <Button asChild variant="outline">
                    <Link href={qs({ page: String(page - 1) })}>Previous</Link>
                  </Button>
                ) : (
                  <span />
                )}
                {page < pages && (
                  <Button asChild variant="outline">
                    <Link href={qs({ page: String(page + 1) })}>Next</Link>
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
