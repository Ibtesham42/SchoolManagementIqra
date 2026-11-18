import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError } from "@/lib/errors";
import { authorize, buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant } from "@/lib/rbac/catalog";
import { canReadSection, classScopeWhere, sectionScopeWhere } from "@/modules/academic/academic.policy";
import {
  assertCapacityFits,
  assertClassCodeChangeAllowed,
  assertSectionRenameAllowed,
  assertSessionWritable,
  changedFields,
  collapseSpaces,
  DEFAULT_SECTION_CAPACITY,
  nameKeyOf,
  planSectionCopy,
  resolveCapacity,
  sectionCodeOf,
  targetKey,
} from "@/modules/academic/academic.rules";
import {
  assignClassTeacherSchema,
  copySectionsSchema,
  createClassSchema,
  createSectionsBulkSchema,
  defaultSectionCapacitySchema,
  setActiveSchema,
  splitSectionNames,
  updateClassSchema,
  updateSectionSchema,
} from "@/modules/academic/academic.schemas";

/** Phase 2 classes & sections — pure rules, schemas and scope policy (design §5, §6, §8). */

const classInput = { code: "c06", name: "  Class   6 ", numericLevel: "6", displayOrder: "", defaultSectionCapacity: "" };

describe("class schema", () => {
  it("normalises code (uppercase), name (trim/collapse) and numbers from form strings", () => {
    expect(createClassSchema.parse(classInput)).toEqual({ code: "C06", name: "Class 6", numericLevel: 6, displayOrder: 0, defaultSectionCapacity: null });
  });
  it.each(["C11-SCI", "LKG", "C1-A-B", "X"])("accepts code %s", (code) => {
    expect(createClassSchema.safeParse({ ...classInput, code }).success).toBe(true);
  });
  it.each(["", "C-", "-C", "C--1", "C 6", "C_6", "ABCDEFGHIJK", "C६"])("rejects code %j", (code) => {
    expect(createClassSchema.safeParse({ ...classInput, code }).success).toBe(false);
  });
  it("rejects non-ASCII and empty names (keeps SQL lower() equal to JS toLowerCase())", () => {
    expect(createClassSchema.safeParse({ ...classInput, name: "कक्षा 6" }).success).toBe(false);
    expect(createClassSchema.safeParse({ ...classInput, name: "   " }).success).toBe(false);
    expect(createClassSchema.safeParse({ ...classInput, name: "x".repeat(61) }).success).toBe(false);
  });
  it.each([["-3", true], ["12", true], ["-4", false], ["13", false], ["6.5", false], ["1e1", false], ["0x6", false], ["", false]])("level %j → %s", (level, ok) => {
    expect(createClassSchema.safeParse({ ...classInput, numericLevel: level }).success).toBe(ok);
  });
  it.each([["1", 1], ["200", 200], ["40", 40]])("capacity %j → %d", (cap, n) => {
    expect(createClassSchema.parse({ ...classInput, defaultSectionCapacity: cap }).defaultSectionCapacity).toBe(n);
  });
  it.each(["0", "201", "-1", "12.5", "abc"])("rejects capacity %j", (cap) => {
    expect(createClassSchema.safeParse({ ...classInput, defaultSectionCapacity: cap }).success).toBe(false);
  });
  it("is strict: unknown keys are rejected", () => {
    expect(createClassSchema.safeParse({ ...classInput, isActive: true }).success).toBe(false);
    expect(updateClassSchema.safeParse({ ...classInput, id: "x", version: "1", nameKey: "class 6" }).success).toBe(false);
  });
  it("updates require a version ≥ 1", () => {
    expect(updateClassSchema.safeParse({ ...classInput, id: "x", version: "" }).success).toBe(false);
    expect(updateClassSchema.safeParse({ ...classInput, id: "x", version: "0" }).success).toBe(false);
    expect(updateClassSchema.parse({ ...classInput, id: "x", version: "3" }).version).toBe(3);
  });
});

describe("section schemas", () => {
  const bulk = { academicSessionId: "s1", classId: "c1", names: ["A", "B"], capacity: "" };
  it("bulk create: names collapsed, capacity optional (null = resolve later)", () => {
    expect(createSectionsBulkSchema.parse({ ...bulk, names: [" Rose   Garden ", "b"] })).toEqual({ academicSessionId: "s1", classId: "c1", names: ["Rose Garden", "b"], capacity: null });
  });
  it("bulk create: refuses duplicate names case-insensitively, punctuation, empty and > 26 names", () => {
    expect(createSectionsBulkSchema.safeParse({ ...bulk, names: ["A", "a"] }).success).toBe(false);
    expect(createSectionsBulkSchema.safeParse({ ...bulk, names: ["A-1"] }).success).toBe(false);
    expect(createSectionsBulkSchema.safeParse({ ...bulk, names: [] }).success).toBe(false);
    expect(createSectionsBulkSchema.safeParse({ ...bulk, names: Array.from({ length: 27 }, (_, i) => `S${i}`) }).success).toBe(false);
    expect(createSectionsBulkSchema.safeParse({ ...bulk, names: ["x".repeat(21)] }).success).toBe(false);
  });
  it("update requires a capacity; assign requires a user; copy refuses the same session", () => {
    expect(updateSectionSchema.safeParse({ id: "x", version: "1", name: "A", capacity: "" }).success).toBe(false);
    expect(updateSectionSchema.parse({ id: "x", version: "1", name: "A", capacity: "35" }).capacity).toBe(35);
    expect(assignClassTeacherSchema.safeParse({ id: "x", version: "1", userId: "" }).success).toBe(false);
    expect(copySectionsSchema.safeParse({ fromSessionId: "a", toSessionId: "a" }).success).toBe(false);
    expect(copySectionsSchema.safeParse({ fromSessionId: "a", toSessionId: "b" }).success).toBe(true);
    expect(setActiveSchema.safeParse({ id: "x", version: "1", active: "true" }).success).toBe(false); // boolean only
  });
  it("default capacity setting: 1–200", () => {
    expect(defaultSectionCapacitySchema.parse({ defaultSectionCapacity: "40" })).toEqual({ defaultSectionCapacity: 40 });
    expect(defaultSectionCapacitySchema.safeParse({ defaultSectionCapacity: "0" }).success).toBe(false);
    expect(defaultSectionCapacitySchema.safeParse({ defaultSectionCapacity: "" }).success).toBe(false);
  });
  it.each([
    ["A, B, C, D", ["A", "B", "C", "D"]],
    ["A B C", ["A", "B", "C"]],
    ["Rose Garden, Lily", ["Rose Garden", "Lily"]],
    ["A\nB\n\n C ", ["A", "B", "C"]],
    ["  ", []],
  ])("splitSectionNames(%j)", (raw, names) => {
    expect(splitSectionNames(raw)).toEqual(names);
  });
});

describe("codes, keys and capacity", () => {
  it("section code = class code + NAME without spaces", () => {
    expect(sectionCodeOf("C06", "A")).toBe("C06-A");
    expect(sectionCodeOf("C06", "rose garden")).toBe("C06-ROSEGARDEN");
    expect(sectionCodeOf("C11-SCI", "b")).toBe("C11-SCI-B");
    // Matches the DB CHECK on section.code.
    expect(sectionCodeOf("C11-SCI", "Blue 2")).toMatch(/^[A-Z0-9]+(-[A-Z0-9]+)+$/);
    expect(sectionCodeOf("ABCDEFGHIJ", "x".repeat(20)).length).toBeLessThanOrEqual(32);
  });
  it("name key = lower(trim/collapse)", () => {
    expect(nameKeyOf("  Class   6 ")).toBe("class 6");
    expect(collapseSpaces("\tA \n B ")).toBe("A B");
  });
  it("capacity resolution: form → class default → school default → 40", () => {
    expect(resolveCapacity(35, 30, 45)).toBe(35);
    expect(resolveCapacity(null, 30, 45)).toBe(30);
    expect(resolveCapacity(null, null, 45)).toBe(45);
    expect(resolveCapacity(undefined, undefined, undefined)).toBe(DEFAULT_SECTION_CAPACITY);
    expect(DEFAULT_SECTION_CAPACITY).toBe(40);
  });
});

describe("guards", () => {
  it("CLOSED sessions are read-only; PLANNED and ACTIVE are writable", () => {
    expect(() => assertSessionWritable("CLOSED")).toThrow(ConflictError);
    expect(() => assertSessionWritable("PLANNED")).not.toThrow();
    expect(() => assertSessionWritable("ACTIVE")).not.toThrow();
  });
  it("capacity can't drop below active enrollments", () => {
    expect(() => assertCapacityFits(30, 31)).toThrow(ConflictError);
    expect(() => assertCapacityFits(31, 31)).not.toThrow();
  });
  it("class code fixed once sections exist; section name fixed once students are enrolled", () => {
    expect(() => assertClassCodeChangeAllowed("C06", "C6", 1)).toThrow(ConflictError);
    expect(() => assertClassCodeChangeAllowed("C06", "C6", 0)).not.toThrow();
    expect(() => assertClassCodeChangeAllowed("C06", "C06", 5)).not.toThrow();
    expect(() => assertSectionRenameAllowed("A", "B", 1)).toThrow(ConflictError);
    expect(() => assertSectionRenameAllowed("A", "B", 0)).not.toThrow();
  });
  it("changedFields keeps only real changes", () => {
    expect(changedFields({ name: "A", capacity: 40, code: "C06-A" }, { name: "A", capacity: 35 })).toEqual({ before: { capacity: 40 }, after: { capacity: 35 } });
    expect(changedFields({ a: 1 }, { a: 1 })).toEqual({ before: {}, after: {} });
  });
});

describe("copy-from-session plan", () => {
  const src = (over: Partial<Parameters<typeof planSectionCopy>[0][number]> = {}) => ({
    classId: "c6", classCode: "C06", classActive: true, name: "A", nameKey: "a", capacity: 38, isActive: true, ...over,
  });
  it("copies active sections of active classes with name and capacity; recomputes the code", () => {
    const plan = planSectionCopy([src(), src({ name: "B", nameKey: "b", capacity: 42 })], []);
    expect(plan).toEqual({
      create: [
        { classId: "c6", name: "A", nameKey: "a", code: "C06-A", capacity: 38 },
        { classId: "c6", name: "B", nameKey: "b", code: "C06-B", capacity: 42 },
      ],
      skipped: 0,
    });
    expect(Object.keys(plan.create[0])).not.toContain("classTeacherId"); // class teachers never copied (A3)
  });
  it("ignores inactive sections and sections of inactive classes", () => {
    expect(planSectionCopy([src({ isActive: false }), src({ classActive: false, nameKey: "b" })], []).create).toEqual([]);
  });
  it("skips existing (class, name) pairs — idempotent", () => {
    const first = planSectionCopy([src(), src({ name: "B", nameKey: "b" })], [targetKey("c6", "b")]);
    expect(first.create.map((r) => r.name)).toEqual(["A"]);
    expect(first.skipped).toBe(1);
    const again = planSectionCopy([src(), src({ name: "B", nameKey: "b" })], [targetKey("c6", "a"), targetKey("c6", "b")]);
    expect(again).toEqual({ create: [], skipped: 2 });
  });
  it("same name in another class is not a clash", () => {
    expect(planSectionCopy([src(), src({ classId: "c7", classCode: "C07" })], [targetKey("c6", "a")]).create.map((r) => r.code)).toEqual(["C07-A"]);
  });
});

function ctxFor(roleKey: string): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: normalizeGrant(g).key, scope: normalizeGrant(g).scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}

describe("academic RBAC and record scope (D2)", () => {
  it.each(["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "ADMISSION_OFFICER"])("%s reads all classes and sections", (role) => {
    expect(authorize(ctxFor(role), "academic.read")).toBe("ALL");
  });
  it.each(["TEACHER", "CLASS_TEACHER"])("%s reads ASSIGNED only", (role) => {
    expect(authorize(ctxFor(role), "academic.read")).toBe("ASSIGNED");
  });
  it.each(["ACCOUNTANT", "HR_MANAGER", "TRANSPORT_MANAGER", "LIBRARIAN", "PARENT", "STUDENT"])("%s has no academic.read", (role) => {
    expect(() => authorize(ctxFor(role), "academic.read")).toThrow(ForbiddenError);
  });
  it("only Super Admin and School Admin manage classes and sections", () => {
    const managers = ROLES.filter((r) => {
      try {
        authorize(ctxFor(r.key), "academic.manage");
        return true;
      } catch {
        return false;
      }
    }).map((r) => r.key);
    expect(managers).toEqual(["SUPER_ADMIN", "SCHOOL_ADMIN"]);
  });
  it("ALL → no filter; ASSIGNED → own class-teacher sections and their classes; other scopes refused", () => {
    const t = ctxFor("TEACHER");
    expect(sectionScopeWhere(t, "ALL")).toEqual({});
    expect(sectionScopeWhere(t, "ASSIGNED")).toEqual({ classTeacherId: "u-TEACHER", academicSession: { status: { not: "CLOSED" } } }); // S-02
    expect(classScopeWhere(t, "ASSIGNED")).toEqual({ sections: { some: { classTeacherId: "u-TEACHER", academicSession: { status: { not: "CLOSED" } } } } });
    expect(() => sectionScopeWhere(t, "SELF")).toThrow(ForbiddenError);
    expect(() => classScopeWhere(t, "CHILDREN")).toThrow(ForbiddenError);
  });
  it("single-record check matches the list filter", () => {
    const t = ctxFor("TEACHER");
    expect(canReadSection(t, "ASSIGNED", { classTeacherId: "u-TEACHER", sessionStatus: "ACTIVE" })).toBe(true);
    expect(canReadSection(t, "ASSIGNED", { classTeacherId: "u-TEACHER", sessionStatus: "PLANNED" })).toBe(true);
    expect(canReadSection(t, "ASSIGNED", { classTeacherId: "u-TEACHER", sessionStatus: "CLOSED" })).toBe(false); // S-02
    expect(canReadSection(t, "ALL", { classTeacherId: null, sessionStatus: "CLOSED" })).toBe(true);
    expect(canReadSection(t, "ASSIGNED", { classTeacherId: "someone-else", sessionStatus: "ACTIVE" })).toBe(false);
    expect(canReadSection(t, "ASSIGNED", { classTeacherId: null, sessionStatus: "ACTIVE" })).toBe(false);
    expect(canReadSection(t, "ALL", { classTeacherId: null, sessionStatus: "ACTIVE" })).toBe(true);
    expect(canReadSection(t, "SELF", { classTeacherId: "u-TEACHER", sessionStatus: "ACTIVE" })).toBe(false);
  });
});

describe("navigation: Classes needs academic.read (manage alone shows nothing)", () => {
  it("a user holding only academic.manage — e.g. School Admin before the academic.read seed sync — gets no Classes item", async () => {
    const { visibleNavItems } = await import("@/components/erp/nav-items");
    const { hasPermission, scopeFor } = await import("@/lib/rbac/authorize");
    const manageOnly: AuthContext = { ...ctxFor("SCHOOL_ADMIN"), permissions: buildPermissionMap([{ roleKey: "X", isSystem: false, permissionKey: "academic.manage", scope: "ALL" }]) };
    expect(visibleNavItems((p) => hasPermission(manageOnly, p), (p) => scopeFor(manageOnly, p)).map((i) => i.label)).not.toContain("Classes");
    expect(visibleNavItems((p) => hasPermission(ctxFor("TEACHER"), p), (p) => scopeFor(ctxFor("TEACHER"), p)).map((i) => i.label)).toContain("Classes");
  });
});
