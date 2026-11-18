import { CheckCircle2, CircleOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { setDepartmentActiveAction, setDesignationActiveAction } from "./actions";
import { MasterForm } from "./master-form";

export interface MasterRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  version: number;
  staffType?: "TEACHING" | "NON_TEACHING";
  _count: { employees: number };
}

const STAFF_TYPE_LABEL = { TEACHING: "Teaching", NON_TEACHING: "Non-teaching" } as const;

function Actions({ kind, row, view }: { kind: "department" | "designation"; row: MasterRow; view: "t" | "c" }) {
  const toggle = kind === "department" ? setDepartmentActiveAction : setDesignationActiveAction;
  return (
    <div className="grid gap-2">
      <details className="rounded-lg border p-3 open:pb-4">
        <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium pointer-fine:min-h-9">Edit {row.name}</summary>
        <div className="mt-3">
          <MasterForm kind={kind} idPrefix={view} defaults={{ id: row.id, version: row.version, code: row.code, name: row.name, staffType: row.staffType, locked: row._count.employees > 0 }} />
        </div>
      </details>
      {row.isActive ? (
        <ConfirmAction
          label="Deactivate"
          icon={<CircleOff aria-hidden="true" />}
          variant="destructive"
          title={`Deactivate ${row.name}?`}
          description={`New employees can't be given an inactive ${kind}. Staff who already have it are not changed.`}
          confirmLabel="Deactivate"
          action={toggle}
          fields={{ id: row.id, version: String(row.version), active: "false" }}
        />
      ) : (
        <ConfirmAction
          label="Activate"
          icon={<CheckCircle2 aria-hidden="true" />}
          title={`Activate ${row.name}?`}
          description={`The ${kind} can be chosen for new employees again.`}
          confirmLabel="Activate"
          action={toggle}
          fields={{ id: row.id, version: String(row.version), active: "true" }}
        />
      )}
    </div>
  );
}

const Status = ({ active }: { active: boolean }) => <Badge variant={active ? "default" : "secondary"}>{active ? "Active" : "Inactive"}</Badge>;

/** Department or designation master list: table ≥ md, cards < md; edit/deactivate for employee.manage holders. */
export function MasterList({ kind, rows, canManage }: { kind: "department" | "designation"; rows: MasterRow[]; canManage: boolean }) {
  const plural = kind === "department" ? "departments" : "designations";
  const withType = kind === "designation";
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>All {plural}</h2>
          </CardTitle>
          <CardDescription>{rows.length === 0 ? `No ${plural} yet.` : `${rows.length} ${rows.length === 1 ? kind : plural}.`}</CardDescription>
        </CardHeader>
        {rows.length > 0 && (
          <CardContent>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-muted-foreground">
                <tr className="border-b">
                  <th scope="col" className="py-2 pr-3 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Code</th>
                  {withType && <th scope="col" className="py-2 pr-3 font-medium">Staff type</th>}
                  <th scope="col" className="py-2 pr-3 font-medium">Staff</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  {canManage && <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b align-top last:border-0">
                    <td className="py-3 pr-3 font-medium">{r.name}</td>
                    <td className="py-3 pr-3 font-mono">{r.code}</td>
                    {withType && <td className="py-3 pr-3">{r.staffType ? STAFF_TYPE_LABEL[r.staffType] : ""}</td>}
                    <td className="py-3 pr-3">{r._count.employees}</td>
                    <td className="py-3 pr-3"><Status active={r.isActive} /></td>
                    {canManage && (
                      <td className="w-72 py-3">
                        <Actions kind={kind} row={r} view="t" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="grid gap-3 md:hidden">
              {rows.map((r) => (
                <li key={r.id} className="grid gap-2 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Status active={r.isActive} />
                  </div>
                  <dl className="grid grid-cols-2 gap-1 text-sm">
                    <dt className="text-muted-foreground">Code</dt>
                    <dd className="font-mono">{r.code}</dd>
                    {withType && (
                      <>
                        <dt className="text-muted-foreground">Staff type</dt>
                        <dd>{r.staffType ? STAFF_TYPE_LABEL[r.staffType] : ""}</dd>
                      </>
                    )}
                    <dt className="text-muted-foreground">Staff</dt>
                    <dd>{r._count.employees}</dd>
                  </dl>
                  {canManage && <Actions kind={kind} row={r} view="c" />}
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
              <h2>New {kind}</h2>
            </CardTitle>
            <CardDescription>{kind === "department" ? "Departments group staff, e.g. Science, Languages, Administration." : "Designations are job titles. Each one is teaching or non-teaching."}</CardDescription>
          </CardHeader>
          <CardContent>
            <MasterForm kind={kind} defaults={{ code: "", name: "" }} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
