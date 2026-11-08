"use client";

import { useActionState } from "react";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import type { PermissionKey, Scope } from "@/lib/rbac/catalog";
import { setRolePermissionsAction } from "../actions";

export interface PermissionRow {
  key: PermissionKey;
  module: string;
  description: string;
  scope: Scope | "";
  locked: boolean;
}

const SCOPE_LABEL: Record<Scope | "", string> = {
  "": "Not granted",
  ALL: "All records",
  ASSIGNED: "Assigned only",
  SELF: "Own record only",
  CHILDREN: "Linked children only",
};

const MODULE_LABEL: Record<string, string> = {
  user: "Users",
  role: "Roles",
  settings: "Settings",
  session: "Academic sessions",
  template: "Templates",
  cms: "Website CMS",
  enquiry: "Admission enquiries",
  admission: "Admissions",
  student: "Students",
  discipline: "Discipline",
  rollnumber: "Roll numbers",
  idcard: "ID cards",
  document: "Documents",
  certificate: "Certificates",
  employee: "Employees",
  leave: "Leave",
  attendance: "Attendance",
  payroll: "Payroll",
  salary: "Salary",
  fee: "Fees",
  transport: "Transport",
  academic: "Academics",
  timetable: "Timetable",
  exam: "Examinations",
  marks: "Marks",
  result: "Results",
  reportcard: "Report cards",
  library: "Library",
  inventory: "Inventory",
  import: "Import",
  export: "Export",
  chatbot: "Chatbot",
  notice: "Notices",
  audit: "Audit",
  backup: "Backup",
  integration: "Integrations",
  notification: "Notifications",
  usage: "Free-tier usage",
};

/**
 * Native <select> per permission: accessible, works with plain form submission, and uses the
 * phone's own picker on mobile. Locked rows submit their current value via a hidden input so
 * the server receives the complete set (the server re-validates anti-escalation regardless).
 */
export function PermissionEditor({ roleId, rows, readOnly }: { roleId: string; rows: PermissionRow[]; readOnly: boolean }) {
  const [state, action] = useActionState(setRolePermissionsAction, initialState);
  const modules = [...new Set(rows.map((r) => r.module))];
  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="id" value={roleId} />
      {modules.map((m) => (
        <fieldset key={m} className="grid gap-1">
          <legend className="mb-1 text-sm font-semibold">{MODULE_LABEL[m] ?? m}</legend>
          {rows
            .filter((r) => r.module === m)
            .map((r) => {
              const id = `perm-${r.key}`;
              return (
                <div key={r.key} className="flex flex-col gap-1 rounded-lg px-2 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4 even:bg-muted/40">
                  {readOnly || r.locked ? (
                    <div className="min-w-0 text-sm">
                      <span className="block">{r.description}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{r.key}</span>
                    </div>
                  ) : (
                    <label htmlFor={id} className="min-w-0 text-sm">
                      <span className="block">{r.description}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{r.key}</span>
                    </label>
                  )}
                  {readOnly || r.locked ? (
                    <>
                      <span className="text-sm text-muted-foreground sm:w-48 sm:text-right">
                        {SCOPE_LABEL[r.scope]}
                      </span>
                      {!readOnly && r.scope && <input type="hidden" name={`perm.${r.key}`} value={r.scope} />}
                    </>
                  ) : (
                    <select
                      id={id}
                      name={`perm.${r.key}`}
                      defaultValue={r.scope}
                      className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm sm:h-9 sm:w-48"
                    >
                      {(Object.keys(SCOPE_LABEL) as (Scope | "")[]).map((s) => (
                        <option key={s || "none"} value={s}>
                          {SCOPE_LABEL[s]}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
        </fieldset>
      ))}
      {!readOnly && (
        <div className="sticky bottom-16 z-10 grid gap-2 rounded-xl border bg-background/95 p-3 backdrop-blur lg:bottom-4">
          <FormStatus state={state} />
          <SubmitButton className="w-full sm:w-auto">Save permissions</SubmitButton>
        </div>
      )}
    </form>
  );
}
