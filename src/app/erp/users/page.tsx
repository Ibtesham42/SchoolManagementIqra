import Link from "next/link";
import { Plus, Search } from "lucide-react";
import { requireAuth } from "@/lib/auth/context";
import { hasPermission } from "@/lib/rbac/authorize";
import { listUsers } from "@/modules/identity/users.service";
import { listUsersSchema } from "@/modules/identity/identity.schemas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PageHeader } from "@/components/erp/page-header";
import { cn } from "@/lib/utils";
import { NotPermitted } from "@/components/erp/not-permitted";

export const metadata = { title: "Users" };

type Search = { q?: string; status?: string; page?: string };

function StatusBadge({ active, locked }: { active: boolean; locked: boolean }) {
  if (!active) return <Badge variant="secondary">Inactive</Badge>;
  if (locked) return <Badge variant="destructive">Locked</Badge>;
  return <Badge variant="outline">Active</Badge>;
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const ctx = await requireAuth();
  if (!hasPermission(ctx, "user.read")) return <NotPermitted />;
  const sp = await searchParams;
  const parsed = listUsersSchema.safeParse({ q: sp.q || undefined, status: sp.status ?? "all", page: sp.page ?? 1 });
  const input = parsed.success ? parsed.data : listUsersSchema.parse({}); // malformed URL → defaults, not an error page
  const { rows, total, page, pageSize } = await listUsers(ctx, input);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const href = (patch: Partial<Search>) => {
    const p = new URLSearchParams({ ...(input.q ? { q: input.q } : {}), status: input.status, ...patch } as Record<string, string>);
    return `/erp/users?${p}`;
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Users"
        description={`${total} account${total === 1 ? "" : "s"}`}
        actions={
          hasPermission(ctx, "user.manage") && (
            <Button asChild>
              <Link href="/erp/users/new">
                <Plus aria-hidden="true" /> New user
              </Link>
            </Button>
          )
        }
      />

      <form role="search" className="mb-4 flex gap-2" action="/erp/users">
        <label htmlFor="q" className="sr-only">
          Search users
        </label>
        <Input id="q" name="q" type="search" defaultValue={input.q} placeholder="Search name, username or email" />
        <input type="hidden" name="status" value={input.status} />
        <Button type="submit" variant="outline" aria-label="Search">
          <Search aria-hidden="true" />
        </Button>
      </form>
      <nav aria-label="Filter by status" className="mb-4 flex gap-2">
        {(["all", "active", "inactive"] as const).map((s) => (
          <Link
            key={s}
            href={href({ status: s, page: "1" })}
            aria-current={input.status === s ? "true" : undefined}
            className={cn(
              "inline-flex min-h-11 items-center rounded-full border px-4 text-sm capitalize sm:min-h-9",
              input.status === s ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {s}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No users match these filters.</CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Username</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sign-in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell>
                      <Link href={`/erp/users/${u.id}`} className="font-medium hover:underline">
                        {u.displayName}
                      </Link>
                      {u.email && <div className="text-xs text-muted-foreground">{u.email}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{u.username}</TableCell>
                    <TableCell className="max-w-64 whitespace-normal text-sm">{u.roles.map((r) => r.role.name).join(", ") || "—"}</TableCell>
                    <TableCell>
                      <StatusBadge active={u.isActive} locked={u.isLocked} />
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{u.lastLoginAt ? u.lastLoginAt.toLocaleDateString("en-IN", { dateStyle: "medium" }) : "Never"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Mobile cards */}
          <ul className="grid gap-2 md:hidden">
            {rows.map((u) => (
              <li key={u.id}>
                <Link href={`/erp/users/${u.id}`} className="block rounded-xl border bg-background p-4 active:bg-muted">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{u.displayName}</p>
                      <p className="truncate font-mono text-xs text-muted-foreground">{u.username}</p>
                    </div>
                    <StatusBadge active={u.isActive} locked={u.isLocked} />
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">{u.roles.map((r) => r.role.name).join(", ") || "No roles"}</p>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-4 flex items-center justify-between gap-2 text-sm">
          {page > 1 ? (
            <Button asChild variant="outline">
              <Link href={href({ page: String(page - 1) })}>Previous</Link>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          {page < pages ? (
            <Button asChild variant="outline">
              <Link href={href({ page: String(page + 1) })}>Next</Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  );
}
