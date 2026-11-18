import { describe, expect, it } from "vitest";
import { authorize, buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ALLOWED_SCOPES, ALL_PERMISSION_KEYS, normalizeGrant, ROLES, type PermissionKey, type Scope } from "@/lib/rbac/catalog";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { canBrowseEmployees, canManageEmployees, canReadPersonal, employeeReadAccess } from "@/modules/hr/hr.policy";
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
  ])("%s is held by exactly %j at ALL", (key, expected) => {
    expect(holders(key)).toEqual(expected);
    for (const r of expected) expect(scopeOf(r, key)).toBe("ALL");
  });

  it("H7: Parent and Student hold no staff permission at all", () => {
    for (const role of ["PARENT", "STUDENT"]) for (const key of ALL_PERMISSION_KEYS.filter((k) => k.startsWith("employee."))) expect(scopeOf(role, key), `${role} ${key}`).toBeNull();
  });

  it("Q2: HR Manager still has no user.manage (account linking stays with user administrators)", () => {
    expect(scopeOf("HR_MANAGER", "user.manage")).toBeNull();
  });

  it("no SELF scope is grantable for staff permissions yet (M3 brings the employee link with its own approval)", () => {
    for (const key of ["employee.read", "employee.personal.read", "employee.manage", "employee.document.manage"] as const) expect(ALLOWED_SCOPES[key]).toEqual(["ALL"]);
  });

  it("a seed sync gives the two NEW permissions their defaults on existing roles — but never adds School Admin employee.manage (needs owner approval)", () => {
    const plan = planSeed();
    const grants = newPermissionGrants(plan, ["employee.personal.read", "employee.document.manage"], new Set());
    expect(grants.map((g) => `${g.roleKey}:${g.key}`).sort()).toEqual(
      ["SCHOOL_ADMIN:employee.personal.read", "PRINCIPAL:employee.personal.read", "HR_MANAGER:employee.personal.read", "SCHOOL_ADMIN:employee.document.manage", "HR_MANAGER:employee.document.manage"].sort(),
    );
    expect(grants.some((g) => g.key === "employee.manage")).toBe(false);
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

  it.each(["ACCOUNTANT", "ADMISSION_OFFICER", "TEACHER", "CLASS_TEACHER", "TRANSPORT_MANAGER", "PARENT", "STUDENT"])("%s can't read staff records (403)", (role) => {
    expect(canBrowseEmployees(ctxFor(role))).toBe(false);
    expect(() => employeeReadAccess(ctxFor(role))).toThrow(ForbiddenError);
  });

  it("a SELF grant (custom role) gives no access in M2 — fails closed until the employee link exists", () => {
    const ctx = ctxFor("TEACHER", [["employee.read", "SELF"], ["employee.personal.read", "SELF"]]);
    expect(canBrowseEmployees(ctx)).toBe(false);
    expect(canReadPersonal(ctx)).toBe(false);
    expect(() => employeeReadAccess(ctx)).toThrow(NotFoundError);
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

describe("registration gate (security review L2)", () => {
  it("a custom role with employee.manage but no personal read can't register (refused before any database access)", async () => {
    const { registerEmployee } = await import("@/modules/hr/employees.service");
    const ctx = ctxFor("TEACHER", [["employee.manage", "ALL"], ["employee.read", "ALL"]]);
    await expect(registerEmployee(ctx, {} as Parameters<typeof registerEmployee>[1])).rejects.toBeInstanceOf(ForbiddenError);
    const noDirectory = ctxFor("TEACHER", [["employee.manage", "ALL"], ["employee.personal.read", "ALL"]]);
    await expect(registerEmployee(noDirectory, {} as Parameters<typeof registerEmployee>[1])).rejects.toBeInstanceOf(ForbiddenError);
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
