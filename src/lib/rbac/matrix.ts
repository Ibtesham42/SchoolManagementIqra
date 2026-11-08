import { ALL_PERMISSION_KEYS, PERMISSIONS, ROLES, normalizeGrant, type PermissionKey, type Scope } from "@/lib/rbac/catalog";

const SCOPE_MARK: Record<Scope, string> = { ALL: "✓", ASSIGNED: "A", SELF: "S", CHILDREN: "C" };

/** Role key → permission → scope, from the seeded defaults. */
export function defaultGrantMatrix(): Map<string, Map<PermissionKey, Scope>> {
  return new Map(
    ROLES.map((role) => [role.key, new Map(role.grants.map((g) => {
      const { key, scope } = normalizeGrant(g);
      return [key, scope] as const;
    }))]),
  );
}

/** Markdown for docs/RBAC_MATRIX.md (regenerate with `npm run rbac:matrix`). */
export function renderMatrixMarkdown(): string {
  const matrix = defaultGrantMatrix();
  const abbrev = ROLES.map((r) => r.key);
  const lines = [
    "# RBAC Matrix (default grants)",
    "",
    "> Generated from `src/lib/rbac/catalog.ts` by `npm run rbac:matrix`. Do not edit by hand —",
    "> `tests/unit/rbac-matrix.test.ts` fails if this file is out of date.",
    "> Super Admin may change non-system roles at runtime; this is the seeded default.",
    "",
    `Legend: ✓ = all records · A = assigned records only · S = own record only · C = linked children only · blank = denied`,
    "",
    `Roles: ${ROLES.length} · Permissions: ${ALL_PERMISSION_KEYS.length}`,
    "",
    `| Permission | ${abbrev.join(" | ")} |`,
    `|---|${abbrev.map(() => ":-:").join("|")}|`,
  ];
  for (const key of ALL_PERMISSION_KEYS) {
    const cells = ROLES.map((r) => {
      const scope = matrix.get(r.key)?.get(key);
      return scope ? SCOPE_MARK[scope] : "";
    });
    lines.push(`| \`${key}\` — ${PERMISSIONS[key]} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Grant counts");
  lines.push("");
  lines.push("| Role | Permissions granted |");
  lines.push("|---|--:|");
  for (const r of ROLES) lines.push(`| ${r.name} (\`${r.key}\`) | ${matrix.get(r.key)?.size ?? 0} |`);
  return lines.join("\n") + "\n";
}
