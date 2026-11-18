import { describe, expect, it } from "vitest";
import { isUniqueViolation, isUniqueViolationOf, uniqueViolationInfo } from "@/lib/db-errors";

/**
 * KI-045: which field a unique violation is about. Error shapes mirror Prisma 7 (P2002 with
 * `meta.target` or `meta.driverAdapterError.cause.constraint`) and raw pg (23505 with
 * `constraint`/`detail`). All synthetic.
 */
const prismaTarget = (target: unknown) => ({ code: "P2002", meta: { target } });
// What @prisma/adapter-pg produces for 23505 when Postgres names the constraint (the usual case).
const adapterIndex = (index: string, table?: string) => ({
  code: "P2002",
  meta: { modelName: "User", driverAdapterError: { cause: { kind: "UniqueConstraintViolation", constraint: { index }, ...(table ? { table } : {}) } } },
});
const adapterFields = (fields: string[]) => ({ code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields } } } } });
const rawPg = (over: Record<string, unknown>) => ({ code: "23505", ...over });

describe("isUniqueViolation — known fields", () => {
  it.each<[string, unknown, string, boolean]>([
    ["Prisma target list, match", prismaTarget(["username"]), "username", true],
    ["Prisma target list, other field", prismaTarget(["email"]), "username", false],
    ["Prisma target as column string", prismaTarget("email"), "email", true],
    ["Prisma target as constraint name", prismaTarget("user_email_key"), "email", true],
    ["Prisma target as constraint name, other field", prismaTarget("user_email_key"), "username", false],
    ["adapter fields, match", adapterFields(["email"]), "email", true],
    ["adapter fields, other field", adapterFields(["email"]), "username", false],
    ["adapter index + table (the G5 case): email", adapterIndex("user_email_key", "user"), "email", true],
    ["adapter index + table (the G5 case): not username", adapterIndex("user_email_key", "user"), "username", false],
    ["adapter index without table: email", adapterIndex("user_email_key"), "email", true],
    ["adapter index without table: not username", adapterIndex("user_email_key"), "username", false],
    ["role key constraint", adapterIndex("role_key_key", "role"), "key", true],
    ["session name constraint", adapterIndex("academic_session_name_key", "academic_session"), "name", true],
    ["camelCase field vs snake_case column", adapterFields(["password_hash"]), "passwordHash", true],
    ["raw pg detail", rawPg({ detail: "Key (email)=(a@example.test) already exists.", constraint: "user_email_key" }), "email", true],
    ["raw pg detail, other field", rawPg({ detail: "Key (email)=(a@example.test) already exists." }), "username", false],
    ["raw pg constraint only", rawPg({ constraint: "user_username_key", table: "user" }), "username", true],
    ["raw pg quoted column", rawPg({ detail: 'Key ("email")=(x) already exists.' }), "email", true],
  ])("%s", (_label, err, field, expected) => {
    expect(isUniqueViolation(err, field)).toBe(expected);
  });

  it("a table-qualified constraint is not confused with a similarly named column on another table", () => {
    expect(isUniqueViolation(adapterIndex("user_backup_email_key", "user"), "email")).toBe(false); // column backup_email
    expect(isUniqueViolation(adapterIndex("user_email_key", "user"), "email")).toBe(true);
  });

  it("does not match a substring of a longer column name", () => {
    expect(isUniqueViolation(prismaTarget(["display_name"]), "name")).toBe(false);
    expect(isUniqueViolation(adapterFields(["usernames"]), "username")).toBe(false);
  });
});

describe("isUniqueViolation — unknown field never matches a specific field (KI-045)", () => {
  it.each<[string, unknown]>([
    ["P2002 with no metadata", { code: "P2002" }],
    ["P2002 with empty meta", { code: "P2002", meta: {} }],
    ["adapter error without constraint", { code: "P2002", meta: { driverAdapterError: { cause: { kind: "UniqueConstraintViolation" } } } }],
    ["adapter foreign-key shaped constraint", { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { foreignKey: {} } } } } }],
    ["raw 23505 with nothing else", { code: "23505" }],
    ["custom constraint name", adapterIndex("uniq_user_contact", "user")],
    ["empty target list", prismaTarget([])],
  ])("%s → false for any field, but still a unique violation", (_label, err) => {
    for (const f of ["username", "email", "key", "name"]) expect(isUniqueViolation(err, f), f).toBe(false);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("the G5 regression: an email clash is never reported as a username clash", () => {
    const emailClash = adapterIndex("user_email_key", "user");
    // createUser checks "username" first, then "email" (users.service.ts).
    expect(isUniqueViolation(emailClash, "username")).toBe(false);
    expect(isUniqueViolation(emailClash, "email")).toBe(true);
  });
});

describe("non-unique errors", () => {
  it.each([null, undefined, "x", 42, new Error("boom"), { code: "P2025" }, { code: "23503", constraint: "user_email_key" }])("%s is not a unique violation", (e) => {
    expect(isUniqueViolation(e)).toBe(false);
    expect(isUniqueViolation(e, "email")).toBe(false);
    expect(uniqueViolationInfo(e)).toBeNull();
  });
  it("uniqueViolationInfo reports what is known", () => {
    expect(uniqueViolationInfo(adapterIndex("user_email_key", "user"))).toEqual({ constraint: "user_email_key", table: "user" });
    expect(uniqueViolationInfo(prismaTarget(["email"]))).toMatchObject({ fields: ["email"] });
  });
});

describe("isUniqueViolationOf — composite and partial indexes (Phase 2 sections)", () => {
  const idx = { index: "section_session_class_teacher_key", fields: ["academicSessionId", "classTeacherId"] };
  it.each<[string, unknown, boolean]>([
    ["adapter index name, match", adapterIndex("section_session_class_teacher_key", "section"), true],
    ["adapter index name, other index", adapterIndex("section_academic_session_id_code_key", "section"), false],
    ["Prisma target as index name", prismaTarget("section_session_class_teacher_key"), true],
    ["Prisma target column list, exact set (any order)", prismaTarget(["class_teacher_id", "academic_session_id"]), true],
    ["adapter fields camelCase, exact set", adapterFields(["academicSessionId", "classTeacherId"]), true],
    ["subset of the columns is not enough", prismaTarget(["academic_session_id"]), false],
    ["superset is not the same index", prismaTarget(["academic_session_id", "class_teacher_id", "code"]), false],
    ["raw pg constraint", rawPg({ constraint: "section_session_class_teacher_key" }), true],
    ["raw pg detail with both columns", rawPg({ detail: "Key (academic_session_id, class_teacher_id)=(a, b) already exists." }), true],
    ["unique violation with no information", { code: "P2002", meta: {} }, false],
    ["not a unique violation", { code: "P2003", meta: { target: "section_session_class_teacher_key" } }, false],
    ["not an error object", "boom", false],
  ])("%s", (_label, err, expected) => {
    expect(isUniqueViolationOf(err, idx)).toBe(expected);
  });
});
