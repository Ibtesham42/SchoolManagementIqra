import Link from "next/link";
import { Trash2 } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { formatDateOnly, toDateInputValue } from "@/lib/format";
import { canBrowseEmployees, canManageEmployees } from "@/modules/hr/hr.policy";
import {
  HOLIDAY_APPLIES_TO_LABEL,
  type HolidayAppliesTo,
} from "@/modules/hr/leave.rules";
import { listHolidays } from "@/modules/hr/leave-setup.service";
import { listSessionsForStaffPlanning } from "@/modules/settings/settings.service";
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
import { removeHolidayAction } from "../actions";
import { HrTabs } from "../hr-tabs";
import { HolidayForm } from "./holiday-form";

export const metadata = { title: "Holidays" };

type Search = Record<string, string | string[] | undefined>;

export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const ctx = await requireAuth();
  if (!canBrowseEmployees(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, currentId } = await listSessionsForStaffPlanning(ctx);
  const wanted =
    typeof sp.session === "string"
      ? sp.session
      : (currentId ?? sessions[0]?.id);
  const session = sessions.find((s) => s.id === wanted) ?? null;
  const holidays = session ? await listHolidays(ctx, session.id) : [];
  const canManage = canManageEmployees(ctx);

  return (
    <div className="mx-auto grid max-w-4xl gap-4">
      <PageHeader
        title="Holidays"
        description="The school calendar for each academic session. Holidays for everyone or for staff are not counted as leave days."
      />
      <HrTabs current="holidays" />
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Create an academic session in Settings first.
        </p>
      ) : (
        <>
          <nav aria-label="Academic session" className="flex flex-wrap gap-2">
            {sessions.map((s) => (
              <Link
                key={s.id}
                href={`/erp/hr/holidays?session=${s.id}`}
                aria-current={s.id === session?.id ? "page" : undefined}
                className="flex min-h-11 items-center rounded-lg border px-3 text-sm aria-[current=page]:border-primary aria-[current=page]:font-medium"
              >
                {s.name}
              </Link>
            ))}
          </nav>
          {session && (
            <Card>
              <CardHeader>
                <CardTitle>
                  <h2>Holidays in {session.name}</h2>
                </CardTitle>
                <CardDescription>
                  {holidays.length === 0
                    ? "No holidays yet."
                    : `${holidays.length} holiday${holidays.length === 1 ? "" : "s"}.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                {holidays.length > 0 && (
                  <ul className="grid gap-2">
                    {holidays.map((h) => (
                      <li
                        key={h.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
                      >
                        <span>
                          <span className="font-medium">
                            {formatDateOnly(h.date)}
                          </span>{" "}
                          · {h.name} ·{" "}
                          <span className="text-muted-foreground">
                            {
                              HOLIDAY_APPLIES_TO_LABEL[
                                h.appliesTo as HolidayAppliesTo
                              ]
                            }
                          </span>
                        </span>
                        {canManage && (
                          <ConfirmAction
                            label="Remove"
                            icon={<Trash2 aria-hidden="true" />}
                            variant="destructive"
                            title={`Remove ${h.name}?`}
                            description="Refused if leave already covers that date or attendance was recorded for it."
                            confirmLabel="Remove"
                            action={removeHolidayAction}
                            fields={{ id: h.id }}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {canManage && session.status !== "CLOSED" && (
                  <HolidayForm
                    min={toDateInputValue(session.startDate)}
                    max={toDateInputValue(session.endDate)}
                  />
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
