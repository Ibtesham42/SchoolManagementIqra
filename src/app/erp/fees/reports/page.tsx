import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { ConflictError } from "@/lib/errors";
import { FEE_REPORT_EXPORT_MESSAGES, isExportCode } from "@/lib/http/export-errors";
import { hasPermission } from "@/lib/rbac/authorize";
import { canReadFeeReports } from "@/modules/fees/fees.policy";
import { RANGE_REPORTS, REPORT_LABEL, REPORT_NAMES, reportQuerySchema, SESSION_REPORTS, type ReportName } from "@/modules/fees/reports.schemas";
import { feeReportOptions, runFeeReport, type ReportTable } from "@/modules/fees/reports.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";
import { FeesTabs, pickSession } from "../fees-tabs";

export const metadata = { title: "Fee reports" };

const FIELD = "h-11 w-full rounded-lg border border-input bg-background px-3 text-base sm:pointer-fine:h-9 sm:text-sm";
const SHOWN_ROWS = 200;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
const daysAgo = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const numeric = (h: string) => /\(Rs\.\)|Receipts|Invoices|Students|overdue|Not fully paid/.test(h);

function ReportView({ t }: { t: ReportTable }) {
  const rows = t.rows.slice(0, SHOWN_ROWS);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t.title}</h2>
        </CardTitle>
        {t.notes.map((n) => (
          <CardDescription key={n}>{n}</CardDescription>
        ))}
      </CardHeader>
      <CardContent className="grid gap-3">
        {t.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing to show for these filters.</p>
        ) : (
          <>
            {t.rows.length > SHOWN_ROWS && (
              <p className="text-sm">
                Showing the first {SHOWN_ROWS} of {t.rows.length} rows. Export the CSV for all of them.
              </p>
            )}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    {t.header.map((h) => (
                      <TableHead key={h} className={numeric(h) ? "text-right" : undefined}>
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      {r.map((c, j) => (
                        <TableCell key={j} className={numeric(t.header[j]) ? "text-right tabular-nums" : "whitespace-normal"}>
                          {c}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
                {t.totals && (
                  <TableFooter>
                    <TableRow>
                      {t.totals.map((c, j) => (
                        <TableCell key={j} className={numeric(t.header[j]) ? "text-right font-medium tabular-nums" : "font-medium"}>
                          {c}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableFooter>
                )}
              </Table>
            </div>
            <ul className="grid gap-2 md:hidden">
              {rows.map((r, i) => (
                <li key={i} className="rounded-xl border p-4">
                  <p className="font-medium">{r[0]}</p>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                    {r.slice(1).map((c, j) =>
                      c === "" ? null : (
                        <div key={j} className="contents">
                          <dt className="text-muted-foreground">{t.header[j + 1]}</dt>
                          <dd className={numeric(t.header[j + 1]) ? "tabular-nums" : undefined}>{c}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                </li>
              ))}
              {t.totals && (
                <li className="rounded-xl border bg-muted/40 p-4 text-sm font-medium">
                  {t.totals
                    .map((c, j) => (c && j > 0 ? `${t.header[j]}: ${c}` : c))
                    .filter(Boolean)
                    .join(" · ")}
                </li>
              )}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default async function FeeReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  if (!canReadFeeReports(ctx)) return <NotPermitted />;
  const sp = await searchParams;
  const { sessions, today } = await feeReportOptions(ctx);
  const report: ReportName = REPORT_NAMES.find((r) => r === one(sp.report)) ?? "collection";
  const session = pickSession(sessions, sp.session);
  const raw = {
    report,
    academicSessionId: SESSION_REPORTS.includes(report) ? session?.id : undefined,
    from: RANGE_REPORTS.includes(report) ? (one(sp.from) ?? daysAgo(today, 30)) : undefined,
    to: RANGE_REPORTS.includes(report) ? (one(sp.to) ?? today) : undefined,
    groupBy: one(sp.groupBy),
    by: one(sp.by),
    minDays: one(sp.minDays),
  };
  const parsed = reportQuerySchema.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)));
  let table: ReportTable | null = null;
  let problem: string | null = parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the filters.");
  if (parsed.success) {
    table = await runFeeReport(ctx, parsed.data).catch((e: unknown) => {
      if (e instanceof ConflictError) {
        problem = e.message;
        return null;
      }
      throw e;
    });
  }
  const q = parsed.success ? parsed.data : null;
  const exportCode = one(sp.export);
  const canExport = hasPermission(ctx, "export.run");
  return (
    <div className="mx-auto grid max-w-6xl gap-4">
      <PageHeader title="Fees" description="Collections, dues, defaulters and registers. Read-only; export any report as CSV." />
      <FeesTabs current="reports" />
      <p className="text-sm">
        <Link href="/erp/fees/reports/reconciliation" className="underline">
          Reconciliation checks
        </Link>{" "}
        — do receipts, invoices and their numbers all add up?
      </p>
      {isExportCode(exportCode) && (
        <Alert variant="destructive">
          <AlertDescription>{FEE_REPORT_EXPORT_MESSAGES[exportCode]}</AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Report</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form method="get" action="/erp/fees/reports" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
            <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-report">
              Report
              <select id="rep-report" name="report" defaultValue={report} className={FIELD}>
                {REPORT_NAMES.map((r) => (
                  <option key={r} value={r}>
                    {REPORT_LABEL[r]}
                  </option>
                ))}
              </select>
            </label>
            {SESSION_REPORTS.includes(report) && (
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-session">
                Academic session
                <select id="rep-session" name="session" defaultValue={session?.id} className={FIELD}>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.status.toLowerCase()})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {RANGE_REPORTS.includes(report) && (
              <>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-from">
                  From
                  <input id="rep-from" type="date" name="from" defaultValue={raw.from} max={today} className={FIELD} />
                </label>
                <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-to">
                  To
                  <input id="rep-to" type="date" name="to" defaultValue={raw.to} className={FIELD} />
                </label>
              </>
            )}
            {report === "collection" && (
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-group">
                Group by
                <select id="rep-group" name="groupBy" defaultValue={q?.groupBy ?? "day"} className={FIELD}>
                  <option value="day">Day</option>
                  <option value="method">Payment method</option>
                  <option value="collector">Collector</option>
                  <option value="category">Fee head</option>
                </select>
              </label>
            )}
            {report === "outstanding" && (
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-by">
                Show by
                <select id="rep-by" name="by" defaultValue={q?.by ?? "class"} className={FIELD}>
                  <option value="class">Class and section</option>
                  <option value="installment">Installment</option>
                </select>
              </label>
            )}
            {report === "defaulters" && (
              <label className="grid gap-1.5 text-sm font-medium" htmlFor="rep-days">
                Overdue by at least (days)
                <input id="rep-days" type="number" name="minDays" min={0} max={365} defaultValue={q?.minDays ?? 1} className={FIELD} />
              </label>
            )}
            <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
              Show
            </button>
          </form>
        </CardContent>
      </Card>
      {problem && (
        <Alert variant="destructive">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      {table && <ReportView t={table} />}
      {table && q && canExport && (
        <form method="post" action={`/api/v1/fees/reports/${q.report}/export`}>
          {q.academicSessionId && <input type="hidden" name="academicSessionId" value={q.academicSessionId} />}
          {q.from && <input type="hidden" name="from" value={q.from} />}
          {q.to && <input type="hidden" name="to" value={q.to} />}
          <input type="hidden" name="groupBy" value={q.groupBy} />
          <input type="hidden" name="by" value={q.by} />
          <input type="hidden" name="minDays" value={String(q.minDays)} />
          <button type="submit" className="min-h-11 rounded-lg border px-4 text-sm font-medium hover:bg-muted">
            Export CSV
          </button>
        </form>
      )}
    </div>
  );
}
