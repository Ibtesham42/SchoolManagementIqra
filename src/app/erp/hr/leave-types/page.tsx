import { CheckCircle2, CircleOff } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { canBrowseEmployees, canManageEmployees } from "@/modules/hr/hr.policy";
import {
  LEAVE_APPLIES_TO_LABEL,
  type LeaveAppliesTo,
} from "@/modules/hr/leave.rules";
import { listLeaveTypes } from "@/modules/hr/leave-setup.service";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { setLeaveTypeActiveAction } from "../actions";
import { HrTabs } from "../hr-tabs";
import { LeaveTypeForm } from "./leave-type-form";

export const metadata = { title: "Leave types" };

type Row = Awaited<ReturnType<typeof listLeaveTypes>>[number];
const days = (v: { toString(): string } | null) =>
  v === null ? "No quota" : `${v.toString()} days`;

function Actions({ t, view }: { t: Row; view: "t" | "c" }) {
  return (
    <div className="grid gap-2">
      <details className="rounded-lg border p-3 open:pb-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">
          Edit {t.name}
        </summary>
        <div className="mt-3">
          <LeaveTypeForm
            idPrefix={view}
            d={{
              id: t.id,
              version: t.version,
              code: t.code,
              name: t.name,
              isPaid: t.isPaid,
              annualQuota: t.annualQuota?.toString() ?? "",
              allowHalfDay: t.allowHalfDay,
              carryForwardMax: t.carryForwardMax.toString(),
              appliesTo: t.appliesTo,
              locked: t.inUse === true,
            }}
          />
        </div>
      </details>
      <ConfirmAction
        label={t.isActive ? "Deactivate" : "Activate"}
        icon={
          t.isActive ? (
            <CircleOff aria-hidden="true" />
          ) : (
            <CheckCircle2 aria-hidden="true" />
          )
        }
        variant={t.isActive ? "destructive" : "outline"}
        title={`${t.isActive ? "Deactivate" : "Activate"} ${t.name}?`}
        description={
          t.isActive
            ? "Staff can no longer apply for this leave. Existing balances and requests are not changed."
            : "Staff can apply for this leave again."
        }
        confirmLabel={t.isActive ? "Deactivate" : "Activate"}
        action={setLeaveTypeActiveAction}
        fields={{
          id: t.id,
          version: String(t.version),
          active: t.isActive ? "false" : "true",
        }}
      />
    </div>
  );
}

export default async function LeaveTypesPage() {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const rows = await listLeaveTypes(ctx, { includeInactive: true });
  const canManage = canManageEmployees(ctx);
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Leave types"
        description="The school's own leave types and yearly quotas (per academic session). Never deleted — deactivate one that is no longer offered."
      />
      <HrTabs current="leave-types" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>All leave types</h2>
          </CardTitle>
          <CardDescription>
            {rows.length === 0
              ? "No leave types yet."
              : `${rows.length} leave type${rows.length === 1 ? "" : "s"}.`}
          </CardDescription>
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Name
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Code
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Quota
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Rules
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  {canManage && (
                    <th scope="col" className="py-2 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b align-top last:border-0">
                    <td className="py-3 pr-3 font-medium">{t.name}</td>
                    <td className="py-3 pr-3 font-mono">{t.code}</td>
                    <td className="py-3 pr-3">{days(t.annualQuota)}</td>
                    <td className="py-3 pr-3">
                      {t.isPaid ? "Paid" : "Unpaid"} ·{" "}
                      {LEAVE_APPLIES_TO_LABEL[t.appliesTo as LeaveAppliesTo]}
                      {t.allowHalfDay ? " · half days" : ""}
                      {Number(t.carryForwardMax) > 0
                        ? ` · carry ≤ ${t.carryForwardMax.toString()}`
                        : ""}
                    </td>
                    <td className="py-3 pr-3">
                      <Badge variant={t.isActive ? "default" : "secondary"}>
                        {t.isActive ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    {canManage && (
                      <td className="w-72 py-3">
                        <Actions t={t} view="t" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {rows.map((t) => (
                <li key={t.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge variant={t.isActive ? "default" : "secondary"}>
                      {t.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="font-mono">{t.code}</span> ·{" "}
                    {days(t.annualQuota)} · {t.isPaid ? "Paid" : "Unpaid"} ·{" "}
                    {LEAVE_APPLIES_TO_LABEL[t.appliesTo as LeaveAppliesTo]}
                  </p>
                  {canManage && <Actions t={t} view="c" />}
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
              <h2>New leave type</h2>
            </CardTitle>
            <CardDescription>
              Use the school&apos;s own rules — for example casual, earned or
              medical leave, and an unpaid (loss-of-pay) type without a quota.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LeaveTypeForm
              d={{
                code: "",
                name: "",
                isPaid: true,
                annualQuota: "",
                allowHalfDay: true,
                carryForwardMax: "0",
                appliesTo: "ALL",
              }}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
