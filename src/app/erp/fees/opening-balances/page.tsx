import { requireAuth } from "@/lib/auth/context";
import { todayInTimeZone } from "@/lib/format";
import { getSchoolTimezone } from "@/modules/settings/settings.public";
import { isExportCode, OPENING_TEMPLATE_MESSAGES } from "@/lib/http/export-errors";
import { canManageFeeSetup } from "@/modules/fees/fees.policy";
import { feeSetupOptions } from "@/modules/fees/setup.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs, pickSession } from "../fees-tabs";
import { OpeningPanel } from "../opening-panel";

export const metadata = { title: "Previous dues" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";

export default async function OpeningBalancesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!canManageFeeSetup(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const [{ sessions, classes }, tz] = await Promise.all([feeSetupOptions(ctx), getSchoolTimezone()]);
  const today = todayInTimeZone(tz ?? undefined);
  const open = sessions.filter((s) => s.status !== "CLOSED");
  const session = pickSession(open, sp.session);
  const cls = classes.find((c) => c.id === sp.class);
  const template = typeof sp.template === "string" && isExportCode(sp.template) ? OPENING_TEMPLATE_MESSAGES[sp.template] : null;
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="Fees" description="Bring in unpaid fees from the old system, once per student, as previous dues." />
      <FeesTabs current="opening" session={session?.id} />
      {!session ? (
        <Alert>
          <AlertDescription>There is no open academic session to add previous dues to.</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Previous dues</h2>
            </CardTitle>
            <CardDescription>One class at a time. Each student gets one &quot;Previous dues&quot; invoice in the session; running the import again skips students who already have one. Past payments are not imported.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <form method="get" action="/erp/fees/opening-balances" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="ob-session">
                Academic session
                <select id="ob-session" name="session" defaultValue={session.id} className={FIELD}>
                  {open.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.status.toLowerCase()})
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="ob-class">
                Class
                <select id="ob-class" name="class" defaultValue={cls?.id ?? ""} className={FIELD} required>
                  <option value="" disabled>
                    Choose a class
                  </option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
                Show
              </button>
            </form>
            {template && (
              <p role="alert" className="text-sm text-destructive">
                {template}
              </p>
            )}
            {cls && <OpeningPanel key={`${session.id}:${cls.id}`} academicSessionId={session.id} classId={cls.id} defaultDueOn={today} templateError={null} />}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
