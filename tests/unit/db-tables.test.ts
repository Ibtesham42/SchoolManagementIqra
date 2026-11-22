import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_TABLES_IN_FK_ORDER, DEFERRED_FK_COLUMNS } from "../../scripts/db-tables";

/**
 * Offline guard for the table list used by `db:check` and the backup drill: it must cover every
 * table in the schema (a missing table would be silently left out of backups) and list parents
 * before children for every foreign key in the migrations (otherwise a restore fails).
 */
const schema = readFileSync(new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
const migrationsDir = new URL("../../prisma/migrations/", import.meta.url);
const migrationSql = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => readFileSync(new URL(`${d.name}/migration.sql`, migrationsDir), "utf8"))
  .join("\n");

describe("APP_TABLES_IN_FK_ORDER", () => {
  it("matches exactly the tables mapped in prisma/schema.prisma", () => {
    const mapped = [...schema.matchAll(/@@map\("([a-z_]+)"\)/g)].map((m) => m[1]).sort();
    expect([...APP_TABLES_IN_FK_ORDER].sort()).toEqual(mapped);
    expect(new Set(APP_TABLES_IN_FK_ORDER).size).toBe(APP_TABLES_IN_FK_ORDER.length);
  });

  it("lists every referenced table before the table that references it (except the listed deferred columns)", () => {
    const fks = [...migrationSql.matchAll(/ALTER TABLE "([a-z_]+)" ADD CONSTRAINT "[a-z_]+" FOREIGN KEY \("([a-z_]+)"\) REFERENCES "([a-z_]+)"/g)];
    expect(fks.length).toBeGreaterThanOrEqual(13); // 9 (init) + 4 (Phase 2a)
    const order = APP_TABLES_IN_FK_ORDER as readonly string[];
    const deferred = DEFERRED_FK_COLUMNS as Readonly<Record<string, readonly string[] | undefined>>;
    const backward: string[] = [];
    for (const [, child, column, parent] of fks) {
      if (child === parent) continue;
      if (order.indexOf(parent) > order.indexOf(child)) backward.push(`${child}.${column}`);
      else expect(deferred[child] ?? [], `${child}.${column} is not a backward FK — remove it from DEFERRED_FK_COLUMNS`).not.toContain(column);
    }
    // Every backward FK is restored in a second step; nothing else may be listed.
    const listed = Object.entries(deferred).flatMap(([t, cols]) => (cols ?? []).map((c) => `${t}.${c}`));
    expect(backward.sort()).toEqual(listed.sort());
    expect(listed).toEqual(["user.employee_id", "user.guardian_id", "user.student_id"]); // sorted above
  });

  it("deferred columns are nullable in the schema (a restore inserts them as NULL first)", () => {
    expect(schema).toMatch(/model User \{[^}]*\n\s+employeeId\s+String\?\s/);
    expect(schema).toMatch(/model User \{[^}]*\n\s+studentId\s+String\?\s/);
    expect(schema).toMatch(/model User \{[^}]*\n\s+guardianId\s+String\?\s/);
  });
});
