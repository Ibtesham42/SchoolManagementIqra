import Link from "next/link";
import { XCircle } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, toDateInputValue } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import {
  LEAVE_QUEUE_STATUSES,
  leaveQueueSchema,
} from "@/modules/hr/leave.schemas";
import { listLeaveQueue } from "@/modules/hr/leave-requests.service";
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
import { cancelLeaveAction } from "../actions";
import { DecideLeaveForm } from "../leave-forms";
import { LeaveTabs, STATUS_LABEL } from "../leave-tabs";

export const metadata = { title: "Leave approvals" };

type Search = Record<string, string | string[] | undefined>;
const range = (from: Date, to: Date, half: string | null) =>
  half
    ? `${formatDateOnly(from)} (${half === "FIRST" ? "first" : "second"} half)`
    : from.getTime() === to.getTime()
      ? formatDateOnly(from)
      : `${formatDateOnly(from)} – ${formatDateOnly(to)}`;

export default async function LeaveApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "leave.approve")) return <NotPermitted />;
  const sp = await searchParams;
  const parsed = leaveQueueSchema.safeParse({
    status: typeof sp.status === "string" ? sp.status : undefined,
    page: typeof sp.page === "string" ? sp.page : undefined,
  });
  const q = parsed.success
    ? parsed.data
    : { status: "PENDING" as const, page: 1 };
  const { items, total, page, pageSize, today } = await listLeaveQueue(ctx, q);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const linked = typeof ctx.employeeId === "string" && ctx.employeeId !== "";

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Leave approvals"
        description="Requests from other staff. You can't decide your own leave."
      />
      <LeaveTabs
        current="approvals"
        showApprovals
        showMine={hasPermission(ctx, "leave.request")}
      />
      {!linked && !ctx.isSuperAdmin && (
        <p className="rounded-lg border p-4 text-sm">
          Your login isn&apos;t linked to your staff record yet: you can see
          requests but not decide them. Ask a Super Admin to link it.
        </p>
      )}
      <nav aria-label="Request status" className="flex flex-wrap gap-2">
        {LEAVE_QUEUE_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/erp/leave/approvals?status=${s}`}
            aria-current={s === q.status ? "page" : undefined}
            className="flex min-h-11 items-center rounded-lg border px-3 text-sm aria-[current=page]:border-primary aria-[current=page]:font-medium"
          >
            {STATUS_LABEL[s]}
          </Link>
        ))}
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{STATUS_LABEL[q.status]} requests</h2>
          </CardTitle>
          <CardDescription>
            {total === 0
              ? "Nothing here."
              : `${total} request${total === 1 ? "" : "s"}${pages > 1 ? ` · page ${page} of ${pages}` : ""}.`}
          </CardDescription>
        </CardHeader>
        {items.length > 0 && (
          <CardContent>
            <ul className="grid gap-3">
              {items.map((r) => (
                <li
                  key={r.id}
                  className="grid gap-2 rounded-lg border p-3 text-sm"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="font-medium">
                      {r.employee.fullName}{" "}
                      <span className="font-mono text-muted-foreground">
                        {r.employee.employeeCode}
                      </span>
                    </span>
                    <span className="flex flex-wrap gap-1">
                      {r.reportsToMe && (
                        <Badge variant="outline">Reports to you</Badge>
                      )}
                      <Badge
                        variant={
                          r.status === "APPROVED"
                            ? "default"
                            : r.status === "PENDING"
                              ? "outline"
                              : "secondary"
                        }
                      >
                        {STATUS_LABEL[r.status]}
                      </Badge>
                    </span>
                  </div>
                  <p className="text-muted-foreground">
                    {r.employee.designation.name} · {r.employee.department.name}
                  </p>
                  <p>
                    {r.leaveType.name}
                    {r.leaveType.isPaid ? "" : " (unpaid)"} ·{" "}
                    {range(r.fromDate, r.toDate, r.halfDay)} ·{" "}
                    <span className="font-medium">
                      {r.days.toString()} day(s)
                    </span>
                    {r.available !== null
                      ? ` · ${r.available} left`
                      : r.leaveType.isPaid
                        ? " · no balance set"
                        : ""}
                  </p>
                  <p>Reason: {r.reason}</p>
                  {r.decisionNote && (
                    <p className="text-muted-foreground">
                      Note: {r.decisionNote}
                    </p>
                  )}
                  {r.decidedBy && r.status !== "PENDING" && (
                    <p className="text-xs text-muted-foreground">
                      Decided by {r.decidedBy.displayName}
                    </p>
                  )}
                  {r.status === "PENDING" && (linked || ctx.isSuperAdmin) && (
                    <details className="rounded-lg border p-3 open:pb-4">
                      <summary className="flex min-h-11 cursor-pointer items-center font-medium pointer-fine:min-h-9">
                        Decide
                      </summary>
                      <div className="mt-3">
                        <DecideLeaveForm
                          id={r.id}
                          version={r.version}
                          idPrefix="q"
                        />
                      </div>
                    </details>
                  )}
                  {r.status === "APPROVED" &&
                    toDateInputValue(r.fromDate) > today &&
                    (linked || ctx.isSuperAdmin) && (
                      <ConfirmAction
                        label="Cancel leave"
                        icon={<XCircle aria-hidden="true" />}
                        variant="destructive"
                        title={`Cancel ${r.employee.fullName}'s leave?`}
                        description="The days go back to the balance and the leave is removed from attendance. Only possible before the first day."
                        confirmLabel="Cancel leave"
                        action={cancelLeaveAction}
                        fields={{ id: r.id, version: String(r.version) }}
                      />
                    )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {page > 1 ? (
            <Link
              href={`/erp/leave/approvals?status=${q.status}&page=${page - 1}`}
              className="flex min-h-11 items-center rounded-lg border px-3 text-sm"
            >
              Previous
            </Link>
          ) : (
            <span />
          )}
          {page < pages && (
            <Link
              href={`/erp/leave/approvals?status=${q.status}&page=${page + 1}`}
              className="flex min-h-11 items-center rounded-lg border px-3 text-sm"
            >
              Next
            </Link>
          )}
        </nav>
      )}
    </div>
  );
}
