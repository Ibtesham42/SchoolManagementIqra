import { redirect } from "next/navigation";
import { XCircle } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, toDateInputValue } from "@/lib/format";
import { hasPermission } from "@/lib/rbac/authorize";
import { available } from "@/modules/hr/leave.rules";
import { getMyLeave } from "@/modules/hr/leave-requests.service";
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
import { cancelLeaveAction } from "./actions";
import { ApplyLeaveForm } from "./leave-forms";
import { LeaveTabs, STATUS_LABEL } from "./leave-tabs";

export const metadata = { title: "My leave" };

const range = (from: Date, to: Date, half: string | null) =>
  half
    ? `${formatDateOnly(from)} (${half === "FIRST" ? "first" : "second"} half)`
    : from.getTime() === to.getTime()
      ? formatDateOnly(from)
      : `${formatDateOnly(from)} – ${formatDateOnly(to)}`;

export default async function MyLeavePage() {
  const ctx = await requireAuth();
  const canApprove = hasPermission(ctx, "leave.approve");
  if (!hasPermission(ctx, "leave.request")) {
    if (canApprove) redirect("/erp/leave/approvals");
    return <NotPermitted />;
  }
  const my = await getMyLeave(ctx);
  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="My leave"
        description="Your leave balances and requests. Weekly offs and holidays are not counted as leave days."
      />
      <LeaveTabs current="mine" showMine showApprovals={canApprove} />
      {!my.linked ? (
        <p className="rounded-lg border p-4 text-sm">
          Your login isn&apos;t linked to your staff record yet, so you
          can&apos;t apply for leave. Ask a Super Admin to link it.
        </p>
      ) : !my.session ? (
        <p className="rounded-lg border p-4 text-sm">
          No current academic session is set. Ask the school office.
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>Balances — {my.session.name}</h2>
              </CardTitle>
              {my.balances.length === 0 && (
                <CardDescription>
                  No balances have been set for you yet. HR sets them at the
                  start of the session.
                </CardDescription>
              )}
            </CardHeader>
            {my.balances.length > 0 && (
              <CardContent>
                <ul className="grid gap-2 sm:grid-cols-2">
                  {my.balances.map((b) => (
                    <li key={b.id} className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">{b.leaveType.name}</p>
                      <p>
                        <span className="text-lg font-semibold">
                          {available(b).toString()}
                        </span>{" "}
                        left · {b.used.toString()} used of{" "}
                        {b.allotted.plus(b.carriedForward).toString()}
                      </p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>

          {my.session.status !== "CLOSED" && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Apply for leave</h2>
                </CardTitle>
                {my.types.length === 0 && (
                  <CardDescription>
                    No leave types are set up yet.
                  </CardDescription>
                )}
              </CardHeader>
              {my.types.length > 0 && (
                <CardContent>
                  <ApplyLeaveForm
                    types={my.types.map((t) => ({
                      id: t.id,
                      label: `${t.name}${t.isPaid ? "" : " (unpaid)"}`,
                      allowHalfDay: t.allowHalfDay,
                    }))}
                    min={toDateInputValue(my.session.startDate)}
                    max={toDateInputValue(my.session.endDate)}
                  />
                </CardContent>
              )}
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>
                <h2>My requests</h2>
              </CardTitle>
              {my.requests.length === 0 && (
                <CardDescription>No requests in this session.</CardDescription>
              )}
            </CardHeader>
            {my.requests.length > 0 && (
              <CardContent>
                <ul className="grid gap-3">
                  {my.requests.map((r) => (
                    <li
                      key={r.id}
                      className="grid gap-2 rounded-lg border p-3 text-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="font-medium">
                          {r.leaveType.name} · {r.days.toString()} day(s)
                        </span>
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
                      </div>
                      <p>{range(r.fromDate, r.toDate, r.halfDay)}</p>
                      <p className="text-muted-foreground">
                        Reason: {r.reason}
                      </p>
                      {r.decisionNote && (
                        <p>Note from the approver: {r.decisionNote}</p>
                      )}
                      {r.status === "PENDING" && (
                        <ConfirmAction
                          label="Withdraw"
                          icon={<XCircle aria-hidden="true" />}
                          variant="outline"
                          title="Withdraw this request?"
                          description="The request is cancelled. You can apply again."
                          confirmLabel="Withdraw"
                          action={cancelLeaveAction}
                          fields={{ id: r.id, version: String(r.version) }}
                        />
                      )}
                      {r.status === "APPROVED" &&
                        toDateInputValue(r.fromDate) > my.today && (
                          <p className="text-xs text-muted-foreground">
                            To cancel approved leave before it starts, ask an
                            approver.
                          </p>
                        )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
