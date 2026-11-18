import { describe, expect, it } from "vitest";
import { authorize, buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ALLOWED_SCOPES, ALL_PERMISSION_KEYS, normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { canBrowseEmployees, canManageEmployees, canReadPersonal, canViewOwnProfile, employeeReadAccess, employeeRecordAccess } from "@/modules/hr/hr.policy";
import {
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeSchema,
  listEmployeesSchema,
  updateEmployeeContactSchema,
  updateEmployeePersonalSchema,
} from "@/modules/hr/hr.schemas";
import { newPermissionGrants, planSeed } from "../../prisma/seed-core";

/**
 * Phase 3A M2 — staff permissions (owner decisions H6, H8, Q1–Q3; PHASE_3_PLAN.md §3a) and input schemas.
 * Table-driven over every catalog role through the real authorize() and the real hr.policy.
 */
function ctxFor(roleKey: string, extra: [PermissionKey, Scope][] = []): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = [...role.grants.map(normalizeGrant), ...extra.map(([key, scope]) => ({ key, scope }))].map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: g.key, scope: g.scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows) };
}
const scopeOf = (roleKey: string, key: PermissionKey): Scope | null => {
  try {
    return authorize(ctxFor(roleKey), key);
  } catch (e) {
    if (e instanceof ForbiddenError) return null;
    throw e;
  }
};
const holders = (key: PermissionKey) => ROLES.map((r) => r.key).filter((k) => scopeOf(k, key) !== null);

describe("staff permissions (catalog, M2)", () => {
  it("adds employee.personal.read and employee.document.manage", () => {
    expect(ALL_PERMISSION_KEYS).toEqual(expect.arrayContaining(["employee.personal.read", "employee.document.manage"]));
  });

  const atAll = (key: PermissionKey) => holders(key).filter((r) => scopeOf(r, key) === "ALL");
  it.each<[PermissionKey, string[]]>([
    // Q3: Librarian keeps the directory (existing grant), Vice Principal via READ_ACADEMIC.
    ["employee.read", ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "HR_MANAGER", "LIBRARIAN"]],
    // Q1: School Admin manages staff records.
    ["employee.manage", ["SUPER_ADMIN", "SCHOOL_ADMIN", "HR_MANAGER"]],
    // H6: personal tier.
    ["employee.personal.read", ["SUPER_ADMIN", "SCHOOL_ADMIN", "PRINCIPAL", "HR_MANAGER"]],
    // H8: documents and photo.
    ["employee.document.manage", ["SUPER_ADMIN", "SCHOOL_ADMIN", "HR_MANAGER"]],
    // Reserved for payroll (3C) — unchanged.
    ["employee.sensitive.read", ["SUPER_ADMIN", "HR_MANAGER"]],
  ])("%s is held at ALL by exactly %j", (key, expected) => {
    expect(atAll(key)).toEqual(expected);
  });

  it("M3b (H7): staff roles read their OWN record at SELF — never Parent or Student", () => {
    expect(holders("employee.read").filter((r) => scopeOf(r, "employee.read") === "SELF")).toEqual(["ACCOUNTANT", "ADMISSION_OFFICER", "TEACHER", "CLASS_TEACHER", "TRANSPORT_MANAGER"]);
    expect(holders("employee.personal.read").filter((r) => scopeOf(r, "employee.personal.read") === "SELF")).toEqual([
      "VICE_PRINCIPAL",
      "ACCOUNTANT",
      "ADMISSION_OFFICER",
      "TEACHER",
      "CLASS_TEACHER",
      "TRANSPORT_MANAGER",
      "LIBRARIAN",
    ]);
  });

  it("H7: Parent and Student hold no staff permission at all", () => {
    for (const role of ["PARENT", "STUDENT"]) for (const key of ALL_PERMISSION_KEYS.filter((k) => k.startsWith("employee."))) expect(scopeOf(role, key), `${role} ${key}`).toBeNull();
  });

  it("Q2: HR Manager still has no user.manage (account linking stays with user administrators)", () => {
    expect(scopeOf("HR_MANAGER", "user.manage")).toBeNull();
  });

  it("SELF is grantable only for the two read permissions (M3b); manage/documents stay ALL-only", () => {
    expect(ALLOWED_SCOPES["employee.read"]).toEqual(["ALL", "SELF"]);
    expect(ALLOWED_SCOPES["employee.personal.read"]).toEqual(["ALL", "SELF"]);
    for (const key of ["employee.manage", "employee.document.manage", "employee.sensitive.read"] as const) expect(ALLOWED_SCOPES[key]).toEqual(["ALL"]);
  });

  it("a seed sync gives the two NEW permissions their defaults on existing roles — but never adds School Admin employee.manage (needs owner approval)", () => {
    const plan = planSeed();
    const grants = newPermissionGrants(plan, ["employee.personal.read", "employee.document.manage"], new Set());
    expect(grants.map((g) => `${g.roleKey}:${g.key}:${g.scope}`).sort()).toEqual(
      [
        ...["SCHOOL_ADMIN", "PRINCIPAL", "HR_MANAGER"].map((r) => `${r}:employee.personal.read:ALL`),
        ...["VICE_PRINCIPAL", "ACCOUNTANT", "ADMISSION_OFFICER", "TEACHER", "CLASS_TEACHER", "TRANSPORT_MANAGER", "LIBRARIAN"].map((r) => `${r}:employee.personal.read:SELF`),
        "SCHOOL_ADMIN:employee.document.manage:ALL",
        "HR_MANAGER:employee.document.manage:ALL",
      ].sort(),
    );
    // Grants on the EXISTING permissions (School Admin employee.manage, employee.read SELF) are never added by a sync.
    expect(grants.some((g) => g.key === "employee.manage" || g.key === "employee.read")).toBe(false);
  });
});

describe("hr.policy tiers", () => {
  it.each([
    ["SUPER_ADMIN", "personal"],
    ["SCHOOL_ADMIN", "personal"],
    ["PRINCIPAL", "personal"],
    ["HR_MANAGER", "personal"],
    ["VICE_PRINCIPAL", "directory"],
    ["LIBRARIAN", "directory"], // Q3: directory fields only
  ])("%s reads the %s tier", (role, tier) => {
    expect(employeeReadAccess(ctxFor(role)).tier).toBe(tier);
    expect(canBrowseEmployees(ctxFor(role))).toBe(true);
    expect(canReadPersonal(ctxFor(role))).toBe(tier === "personal");
  });

  it.each(["ACCOUNTANT", "ADMISSION_OFFICER", "TEACHER", "CLASS_TEACHER", "TRANSPORT_MANAGER"])("%s: no directory (lists look empty — NotFound), own record only, with personal details", (role) => {
    const ctx = { ...ctxFor(role), employeeId: "me" };
    expect(canBrowseEmployees(ctx)).toBe(false);
    expect(() => employeeReadAccess(ctx)).toThrow(NotFoundError);
    expect(employeeRecordAccess(ctx, "me")).toEqual({ tier: "personal", own: true });
    expect(() => employeeRecordAccess(ctx, "someone-else")).toThrow(NotFoundError);
    expect(canViewOwnProfile(ctx)).toBe(true);
  });

  it.each(["PARENT", "STUDENT"])("%s can't read staff records at all (403), even with a link", (role) => {
    const ctx = { ...ctxFor(role), employeeId: "me" };
    expect(() => employeeRecordAccess(ctx, "me")).toThrow(ForbiddenError);
    expect(canViewOwnProfile(ctx)).toBe(false);
  });

  it("SELF without a linked employee gives nothing (fail closed): no own record, no profile link", () => {
    for (const employeeId of [undefined, null, ""]) {
      const ctx = { ...ctxFor("TEACHER"), employeeId };
      expect(() => employeeRecordAccess(ctx, "")).toThrow(NotFoundError);
      expect(canViewOwnProfile(ctx)).toBe(false);
    }
  });

  it("Librarian and Vice Principal: directory for everyone, personal details only for their own record", () => {
    for (const role of ["LIBRARIAN", "VICE_PRINCIPAL"]) {
      const ctx = { ...ctxFor(role), employeeId: "me" };
      expect(employeeRecordAccess(ctx, "other")).toEqual({ tier: "directory", own: false });
      expect(employeeRecordAccess(ctx, "me")).toEqual({ tier: "personal", own: true });
      expect(canReadPersonal(ctx)).toBe(false); // lists and searches stay directory-only
    }
  });

  it("employee.manage holders: Super Admin, School Admin, HR Manager", () => {
    expect(ROLES.map((r) => r.key).filter((k) => canManageEmployees(ctxFor(k)))).toEqual(["SUPER_ADMIN", "SCHOOL_ADMIN", "HR_MANAGER"]);
  });

  it("a forced password change blocks every staff permission", () => {
    const ctx = { ...ctxFor("HR_MANAGER"), mustChangePassword: true };
    expect(canBrowseEmployees(ctx)).toBe(false);
    expect(() => employeeReadAccess(ctx)).toThrow(ForbiddenError);
  });
});

describe("directory filters by tier (security review M1)", () => {
  // Pure where-builder; the service passes the caller's tier from hr.policy.
  const flat = (w: unknown) => JSON.stringify(w);
  it("directory-only readers can't filter by appointment type or search personal phones", async () => {
    const { directoryWhere } = await import("@/modules/hr/employees.service");
    const input = { appointmentType: "CONTRACT" as const, q: "98765 43210", page: 1, pageSize: 25 };
    const dir = flat(directoryWhere(input, "directory"));
    expect(dir).not.toContain("appointmentType");
    expect(dir).not.toContain("personalPhone");
    expect(dir).toContain("workPhone");
    const personal = flat(directoryWhere(input, "personal"));
    expect(personal).toContain('"appointmentType":"CONTRACT"');
    expect(personal).toContain("personalPhone");
  });
});

describe("school-wide lists need the directory (ALL) — SELF is not enough (security review M3b L1)", () => {
  it("department and designation lists refuse a SELF-only reader before any database access", async () => {
    const { listDepartments, listDesignations } = await import("@/modules/hr/master-data.service");
    for (const role of ["TEACHER", "ACCOUNTANT", "ADMISSION_OFFICER", "TRANSPORT_MANAGER"]) {
      const ctx = { ...ctxFor(role), employeeId: "me" };
      await expect(listDepartments(ctx), role).rejects.toBeInstanceOf(NotFoundError);
      await expect(listDesignations(ctx), role).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(listDepartments(ctxFor("PARENT"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("registration gate (security review L2)", () => {
  it("a custom role with employee.manage but no personal read can't register (refused before any database access)", async () => {
    const { registerEmployee } = await import("@/modules/hr/employees.service");
    const ctx = ctxFor("TEACHER", [["employee.manage", "ALL"], ["employee.read", "ALL"]]);
    await expect(registerEmployee(ctx, {} as Parameters<typeof registerEmployee>[1])).rejects.toBeInstanceOf(ForbiddenError);
    // Directory read only at SELF (Teacher's own grant): refused like any out-of-scope access.
    const noDirectory = ctxFor("TEACHER", [["employee.manage", "ALL"], ["employee.personal.read", "ALL"]]);
    await expect(registerEmployee(noDirectory, {} as Parameters<typeof registerEmployee>[1])).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("hr.schemas", () => {
  const employee = {
    firstName: " Asha ",
    middleName: "",
    lastName: "Demo",
    dob: "1985-04-10",
    gender: "FEMALE",
    personalPhone: "+91 98765 43210",
    workPhone: "",
    personalEmail: "",
    workEmail: "ASHA@Example.invalid",
    address: { line1: "", line2: "", city: "", district: "", state: "", pinCode: "", country: "India" },
    emergencyContact: { name: "", relation: "", phone: "" },
    departmentId: "d1",
    designationId: "g1",
    appointmentType: "PERMANENT",
    joiningDate: "2026-06-01",
    confirmationDate: "",
    reportsToId: "",
  };

  it("normalizes a registration (trim, +91 phone, lower-case email, blank optional groups → null)", () => {
    const r = createEmployeeSchema.parse(employee);
    expect(r).toMatchObject({ firstName: "Asha", middleName: null, personalPhone: "9876543210", workPhone: null, workEmail: "asha@example.invalid", address: null, emergencyContact: null, confirmationDate: null, reportsToId: null });
  });

  it("refuses the permanent code, status, staff type or audit fields (strict)", () => {
    for (const extra of [{ employeeCode: "EMP-2026-0001" }, { employmentStatus: "RETIRED" }, { staffType: "TEACHING" }, { createdById: "x" }, { version: 1 }]) {
      expect(createEmployeeSchema.safeParse({ ...employee, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(updateEmployeePersonalSchema.safeParse({ id: "e1", version: "1", firstName: "A", middleName: "", lastName: "", dob: "1985-04-10", gender: "MALE", employeeCode: "X" }).success).toBe(false);
  });

  it("a partly filled address or emergency contact needs all its required fields", () => {
    const r = createEmployeeSchema.safeParse({ ...employee, address: { ...employee.address, city: "Shillong" }, emergencyContact: { name: "Ravi Demo", relation: "", phone: "" } });
    expect(r.success).toBe(false);
    const paths = r.success ? [] : r.error.issues.map((i) => i.path.join("."));
    expect(paths).toEqual(expect.arrayContaining(["address.line1", "address.state", "address.pinCode", "emergencyContact.relation", "emergencyContact.phone"]));
  });

  it("accepts staff born from 1940 (not the student 1990 bound) and refuses earlier", () => {
    expect(createEmployeeSchema.safeParse({ ...employee, dob: "1950-01-01" }).success).toBe(true);
    expect(createEmployeeSchema.safeParse({ ...employee, dob: "1939-12-31" }).success).toBe(false);
  });

  it("contact edits accept a full emergency contact", () => {
    const r = updateEmployeeContactSchema.parse({ id: "e1", version: "3", personalPhone: "9876543210", workPhone: "011 2345 6789", personalEmail: "", workEmail: "", address: { ...employee.address }, emergencyContact: { name: "Ravi Demo", relation: "Spouse", phone: "9123456780" } });
    expect(r).toMatchObject({ version: 3, workPhone: "1123456789", emergencyContact: { name: "Ravi Demo", relation: "Spouse", phone: "9123456780" } });
  });

  it("master data: codes upper-cased and ASCII; names any script; designation needs a staff type", () => {
    expect(createDepartmentSchema.parse({ code: " sci-lab ", name: "  विज्ञान  प्रयोगशाला " })).toEqual({ code: "SCI-LAB", name: "विज्ञान प्रयोगशाला" });
    expect(createDepartmentSchema.safeParse({ code: "विज्ञान", name: "Science" }).success).toBe(false);
    expect(createDepartmentSchema.safeParse({ code: "SCI--LAB", name: "Science" }).success).toBe(false);
    expect(createDesignationSchema.safeParse({ code: "TGT", name: "Trained Graduate Teacher" }).success).toBe(false);
    expect(createDesignationSchema.parse({ code: "TGT", name: "Trained Graduate Teacher", staffType: "TEACHING" }).staffType).toBe("TEACHING");
  });

  it("list filters are bounded (page size ≤ 100, strict)", () => {
    expect(listEmployeesSchema.parse({}).pageSize).toBe(25);
    expect(listEmployeesSchema.safeParse({ pageSize: "101" }).success).toBe(false);
    expect(listEmployeesSchema.safeParse({ personalPhone: "9876543210" }).success).toBe(false);
  });
});
