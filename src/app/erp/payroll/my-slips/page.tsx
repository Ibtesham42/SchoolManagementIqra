import Link from "next/link";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { listMySlips } from "@/modules/payroll/slips.service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NotPermitted } from "@/components/erp/not-permitted";
import { PageHeader } from "@/components/erp/page-header";

export const metadata = { title: "My salary slips" };

export default async function MySlipsPage() {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "salary.self.read")) return <NotPermitted />;
  const mine = await listMySlips(ctx);
  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <PageHeader title="My salary slips" description="Your slips from approved payrolls." />
      {!mine.linked ? (
        <p className="rounded-lg border p-4 text-sm">Your login isn&apos;t linked to your staff record yet, so there are no slips to show. Ask a Super Admin to link it.</p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Slips</h2>
            </CardTitle>
            <CardDescription>{mine.slips.length === 0 ? "No approved slips yet." : `${mine.slips.length} slip(s).`}</CardDescription>
          </CardHeader>
          {mine.slips.length > 0 && (
            <CardContent>
              <ul className="grid gap-2">
                {mine.slips.map((s) => (
                  <li key={s.id}>
                    <Link href={`/erp/payroll/slips/${s.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm hover:bg-muted">
                      <span className="font-medium">{s.run.month.toISOString().slice(0, 7)}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">₹{s.net.toFixed(2)}</span>
                        <Badge variant={s.run.status === "PAID" ? "default" : "outline"}>{s.run.status === "PAID" ? "Paid" : "Approved"}</Badge>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          )}
        </Card>
      )}
    </div>
  );
}
