import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly } from "@/lib/format";
import { canBrowseEmployees } from "@/modules/hr/hr.policy";
import {
  EMPLOYMENT_STATUS_LABEL,
  EMPLOYMENT_STATUSES,
  STAFF_TYPE_LABEL,
  STAFF_TYPES,
} from "@/modules/hr/hr.rules";
import { hrDashboard } from "@/modules/hr/hr-dashboard.service";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { HrTabs } from "./hr-tabs";

export const metadata = { title: "Staff overview" };

type Person = {
  id: string;
  employeeCode: string;
  fullName: string;
  designation: { name: string };
};

function People({
  rows,
  extra,
}: {
  rows: Person[];
  extra?: (p: Person) => string;
}) {
  return (
    <ul className="grid gap-2">
      {rows.map((p) => (
        <li key={p.id}>
          <Link
            href={`/erp/hr/employees/${p.id}`}
            className="flex min-h-11 flex-col justify-center rounded-lg border px-3 py-2 hover:bg-muted"
          >
            <span className="font-medium">{p.fullName}</span>
            <span className="text-xs text-muted-foreground">
              {p.employeeCode} · {p.designation.name}
              {extra ? ` · ${extra(p)}` : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function HrOverviewPage() {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const d = await hrDashboard(ctx);
  const total = (s: (typeof EMPLOYMENT_STATUSES)[number]) =>
    STAFF_TYPES.reduce((n, t) => n + d.counts[t][s], 0);
  const current = (t: (typeof STAFF_TYPES)[number]) =>
    d.counts[t].ACTIVE + d.counts[t].ON_LEAVE;

  return (
    <div className="mx-auto grid max-w-5xl gap-4">
      <PageHeader
        title="Staff overview"
        description="Current staff, departments and the items that need attention."
      />
      <HrTabs current="overview" />

      <ul
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        aria-label="Current staff"
      >
        {STAFF_TYPES.map((t) => (
          <li key={t}>
            <Link
              href={`/erp/hr/employees?type=${t}&status=ACTIVE`}
              className="flex min-h-11 flex-col rounded-lg border p-3 hover:bg-muted"
            >
              <span className="text-2xl font-semibold">{current(t)}</span>
              <span className="text-xs text-muted-foreground">
                {STAFF_TYPE_LABEL[t]} staff
              </span>
            </Link>
          </li>
        ))}
        <li>
          <Link
            href="/erp/hr/employees?status=ON_LEAVE"
            className="flex min-h-11 flex-col rounded-lg border p-3 hover:bg-muted"
          >
            <span className="text-2xl font-semibold">{total("ON_LEAVE")}</span>
            <span className="text-xs text-muted-foreground">
              On long-term leave
            </span>
          </Link>
        </li>
        <li className="flex min-h-11 flex-col rounded-lg border p-3">
          <span className="text-2xl font-semibold">
            {total("RESIGNED") + total("TERMINATED") + total("RETIRED")}
          </span>
          <span className="text-xs text-muted-foreground">
            Former staff (resigned, terminated, retired)
          </span>
        </li>
      </ul>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>By department</h2>
            </CardTitle>
            <CardDescription>
              Current staff (active or on long-term leave).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {d.perDepartment.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No current staff yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Department</th>
                    <th scope="col">Staff</th>
                  </tr>
                </thead>
                <tbody>
                  {d.perDepartment.map((row) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <Link
                          href={`/erp/hr/employees?department=${row.id}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.name}
                        </Link>
                      </td>
                      <td className="py-2 text-right font-medium">
                        {row.count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              <h2>By status</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  {STAFF_TYPES.map((t) => (
                    <th
                      key={t}
                      scope="col"
                      className="py-2 pr-3 text-right font-medium"
                    >
                      {STAFF_TYPE_LABEL[t]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {EMPLOYMENT_STATUSES.map((s) => (
                  <tr key={s} className="border-b last:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal">
                      {EMPLOYMENT_STATUS_LABEL[s]}
                    </th>
                    {STAFF_TYPES.map((t) => (
                      <td key={t} className="py-2 pr-3 text-right">
                        {d.counts[t][s]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {d.joiners && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Recent joiners</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {d.joiners.length ? (
                <People
                  rows={d.joiners}
                  extra={(p) =>
                    `joined ${formatDateOnly((p as Person & { joiningDate: Date }).joiningDate)}`
                  }
                />
              ) : (
                <p className="text-sm text-muted-foreground">Nobody yet.</p>
              )}
            </CardContent>
          </Card>
        )}
        {d.leavers && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Recent leavers</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {d.leavers.length ? (
                <People
                  rows={d.leavers}
                  extra={(p) => {
                    const l = p as Person & {
                      leavingDate: Date | null;
                      employmentStatus: keyof typeof EMPLOYMENT_STATUS_LABEL;
                    };
                    return `${EMPLOYMENT_STATUS_LABEL[l.employmentStatus].toLowerCase()} ${l.leavingDate ? formatDateOnly(l.leavingDate) : ""}`.trim();
                  }}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Nobody has left.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {d.withoutLogin && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Current staff without a linked login account</h2>
              </CardTitle>
              <CardDescription>
                {d.withoutLogin.total === 0
                  ? "Every current staff member has a linked account."
                  : `${d.withoutLogin.total} — not every staff member needs one.`}
              </CardDescription>
            </CardHeader>
            {d.withoutLogin.rows.length > 0 && (
              <CardContent>
                <People rows={d.withoutLogin.rows} />
              </CardContent>
            )}
          </Card>
        )}
        {d.teachersWithoutSection && (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Teachers without a class-teacher section</h2>
              </CardTitle>
              <CardDescription>
                {d.teachersWithoutSection.sessionName === null
                  ? "No current academic session is set."
                  : d.teachersWithoutSection.total === 0
                    ? `Every active teacher is a class teacher in ${d.teachersWithoutSection.sessionName}.`
                    : `${d.teachersWithoutSection.total} active teaching staff in ${d.teachersWithoutSection.sessionName} (not every teacher needs a section).`}
              </CardDescription>
            </CardHeader>
            {d.teachersWithoutSection.rows.length > 0 && (
              <CardContent>
                <People rows={d.teachersWithoutSection.rows} />
              </CardContent>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
