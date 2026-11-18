import Link from "next/link";
import { ArrowLeft, CheckCircle2, Lock, Star } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { formatDateOnly, toDateInputValue } from "@/lib/format";
import { listAcademicSessions } from "@/modules/settings/settings.service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { activateSessionAction, closeSessionAction, setCurrentSessionAction } from "../actions";
import { SessionForm } from "./session-form";

export const metadata = { title: "Academic sessions" };

type Session = Awaited<ReturnType<typeof listAcademicSessions>>["sessions"][number];

const STATUS_LABEL: Record<Session["status"], string> = { PLANNED: "Planned", ACTIVE: "Active", CLOSED: "Closed" };
const STATUS_VARIANT: Record<Session["status"], "outline" | "secondary" | "default"> = { PLANNED: "outline", ACTIVE: "default", CLOSED: "secondary" };

function StatusBadges({ s, isCurrent }: { s: Session; isCurrent: boolean }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge variant={STATUS_VARIANT[s.status]}>{STATUS_LABEL[s.status]}</Badge>
      {isCurrent && (
        <Badge variant="outline">
          <Star aria-hidden="true" /> Current
        </Badge>
      )}
    </span>
  );
}

function SessionActions({ s, isCurrent }: { s: Session; isCurrent: boolean }) {
  const fields = { id: s.id };
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {s.status === "PLANNED" && (
        <ConfirmAction
          label="Activate"
          icon={<CheckCircle2 aria-hidden="true" />}
          title={`Activate ${s.name}?`}
          description="Active sessions accept enrolments, attendance, marks and fees. A session cannot return to Planned."
          confirmLabel="Activate"
          action={activateSessionAction}
          fields={fields}
        />
      )}
      {s.status === "ACTIVE" && !isCurrent && (
        <ConfirmAction
          label="Make current"
          icon={<Star aria-hidden="true" />}
          title={`Make ${s.name} the current session?`}
          description="New admissions, attendance and fee screens will default to this session."
          confirmLabel="Make current"
          action={setCurrentSessionAction}
          fields={fields}
        />
      )}
      {s.status !== "CLOSED" && !isCurrent && (
        <ConfirmAction
          label="Close"
          icon={<Lock aria-hidden="true" />}
          variant="destructive"
          title={`Close ${s.name}?`}
          description="Closing is permanent: the session's records become read-only and it cannot be reopened."
          confirmLabel="Close session"
          action={closeSessionAction}
          fields={fields}
        />
      )}
    </div>
  );
}

export default async function AcademicSessionsPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "settings.read")) return <NotPermitted />;
  const canManage = hasPermission(ctx, "session.manage");
  const { sessions, currentId } = await listAcademicSessions(ctx);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <div>
        <Button asChild variant="ghost" className="-ml-2">
          <Link href="/erp/settings">
            <ArrowLeft aria-hidden="true" /> Settings
          </Link>
        </Button>
      </div>
      <PageHeader
        title="Academic sessions"
        description="Enrolment, attendance, marks, fees and roll numbers belong to a session. Sessions may not overlap; a closed session is read-only."
      />

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Sessions</h2>
          </CardTitle>
          <CardDescription>{sessions.length === 0 ? "No sessions yet." : `${sessions.length} session${sessions.length === 1 ? "" : "s"}, newest first.`}</CardDescription>
        </CardHeader>
        {sessions.length > 0 && (
          <CardContent>
            {/* Table from md up */}
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Dates</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  {canManage && <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} className="border-b align-top last:border-0">
                    <td className="py-3 pr-3 font-medium">{s.name}</td>
                    <td className="py-3 pr-3">
                      {formatDateOnly(s.startDate)} – {formatDateOnly(s.endDate)}
                    </td>
                    <td className="py-3 pr-3">
                      <StatusBadges s={s} isCurrent={s.id === currentId} />
                    </td>
                    {canManage && (
                      <td className="py-3">
                        <SessionActions s={s} isCurrent={s.id === currentId} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Cards below md */}
            <ul className="grid gap-3 md:hidden">
              {sessions.map((s) => (
                <li key={s.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{s.name}</span>
                    <StatusBadges s={s} isCurrent={s.id === currentId} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatDateOnly(s.startDate)} – {formatDateOnly(s.endDate)}
                  </p>
                  {canManage && <SessionActions s={s} isCurrent={s.id === currentId} />}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
      </Card>

      {canManage && (
        <>
          {sessions
            .filter((s) => s.status === "PLANNED")
            .map((s) => (
              <Card key={s.id}>
                <CardHeader>
                  <CardTitle>
                    <h2>Edit {s.name}</h2>
                  </CardTitle>
                  <CardDescription>Only planned sessions can be edited.</CardDescription>
                </CardHeader>
                <CardContent>
                  <SessionForm defaults={{ id: s.id, name: s.name, startDate: toDateInputValue(s.startDate), endDate: toDateInputValue(s.endDate) }} />
                </CardContent>
              </Card>
            ))}
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>New session</h2>
              </CardTitle>
              <CardDescription>Created as Planned. Usually April to March, for example 2026-27 from 1 Apr 2026 to 31 Mar 2027.</CardDescription>
            </CardHeader>
            <CardContent>
              <SessionForm defaults={{ name: "", startDate: "", endDate: "" }} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
