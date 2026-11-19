import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { listRuns } from "@/modules/payroll/runs.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { PayrollTabs } from "../payroll-tabs";
import { CreateRunForm } from "./run-forms";
import { RUN_STATUS } from "./run-status";

export const metadata = { title: "Monthly payroll" };

export default async function RunsPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "payroll.read")) return <NotPermitted />;
  const runs = await listRuns(ctx);
  const today = todayInTimeZone(await getSchoolTimezone());
  const lastMonth = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);
  lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader title="Payroll" description="One payroll per month: create it, prepare it once the month is over and attendance is complete, then send it for approval." />
      <PayrollTabs current="runs" showSalaries />
      {hasPermission(ctx, "payroll.prepare") && (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>New monthly payroll</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <CreateRunForm defaultMonth={lastMonth.toISOString().slice(0, 7)} max={today.slice(0, 7)} />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Payrolls</h2>
          </CardTitle>
          <CardDescription>{runs.length === 0 ? "None yet." : `${runs.length} month(s).`}</CardDescription>
        </CardHeader>
        {runs.length > 0 && (
          <CardContent>
            <ul className="grid gap-2">
              {runs.map((r) => (
                <li key={r.id}>
                  <Link href={`/erp/payroll/runs/${r.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted">
                    <span className="font-medium">{r.month.toISOString().slice(0, 7)}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      {r.status !== "DRAFT" && (
                        <span className="tabular-nums text-muted-foreground">
                          {r.employeeCount} slip(s) · net ₹{r.totalNet.toFixed(2)}
                        </span>
                      )}
                      <Badge variant={r.status === "APPROVED" || r.status === "PAID" ? "default" : "outline"}>{RUN_STATUS[r.status]}</Badge>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
