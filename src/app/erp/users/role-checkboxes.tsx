"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

export interface RoleOption {
  key: string;
  name: string;
  description: string | null;
  /** Disabled options are shown but can't be toggled (e.g. Super Admin for non–Super Admins). */
  disabled?: boolean;
}

export function RoleCheckboxes({ roles, selected, error }: { roles: RoleOption[]; selected: string[]; error?: string }) {
  return (
    <fieldset className="grid gap-2" aria-describedby={error ? "roleKeys-error" : undefined}>
      <legend className="mb-1 text-sm font-medium">Roles</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {roles.map((r) => (
          <div key={r.key} className="flex min-h-11 items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted/60">
            <Checkbox
              id={`role-${r.key}`}
              name="roleKeys"
              value={r.key}
              defaultChecked={selected.includes(r.key)}
              disabled={r.disabled}
              className="mt-0.5"
            />
            <Label htmlFor={`role-${r.key}`} className="grid gap-0.5 font-normal leading-snug">
              <span className="font-medium">{r.name}</span>
              {r.description && <span className="text-xs text-muted-foreground">{r.description}</span>}
            </Label>
          </div>
        ))}
      </div>
      {error && (
        <p id="roleKeys-error" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
