"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  changeEmploymentSchema,
  changeReportingSchema,
  changeStatusSchema,
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeSchema,
  employeeDocumentRefSchema,
  linkAccountSchema,
  setMasterActiveSchema,
  teacherProfileSchema,
  unlinkAccountSchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateEmployeeContactSchema,
  updateEmployeePersonalSchema,
} from "@/modules/hr/hr.schemas";
import { createDepartment, createDesignation, setDepartmentActive, setDesignationActive, updateDepartment, updateDesignation } from "@/modules/hr/master-data.service";
import { registerEmployee, updateEmployeeContact, updateEmployeePersonal } from "@/modules/hr/employees.service";
import { changeEmployment, changeReporting, changeStatus } from "@/modules/hr/employee-lifecycle.service";
import { removeEmployeeDocument, verifyEmployeeDocument } from "@/modules/hr/employee-documents.service";
import { linkStaffAccount, unlinkStaffAccount } from "@/modules/hr/staff-accounts.service";
import { saveTeacherProfile } from "@/modules/hr/teacher-profiles.service";

/** requireAuth → Zod parse → service → refresh; every error becomes a safe ActionState. */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<ActionState | string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const result = await call(ctx, parsed.data);
    revalidatePath("/erp/hr", "layout");
    return typeof result === "string" ? { ok: true, message: result } : result;
  } catch (e) {
    return fromError(e);
  }
}

const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });
const activeRef = (fd: FormData) => ({ ...ref(fd), active: formString(fd, "active") === "true" });

// ───────────────────────────── Master data ─────────────────────────────

export async function createDepartmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createDepartmentSchema, { code: formString(fd, "code"), name: formString(fd, "name") }, async (ctx, d) => `Department ${(await createDepartment(ctx, d))!.name} added.`);
}
export async function updateDepartmentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateDepartmentSchema, { ...ref(fd), code: formString(fd, "code"), name: formString(fd, "name") }, async (ctx, d) => (await updateDepartment(ctx, d), "Department saved."));
}
export async function setDepartmentActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setMasterActiveSchema, activeRef(fd), async (ctx, d) => (await setDepartmentActive(ctx, d), d.active ? "Department activated." : "Department deactivated."));
}
export async function createDesignationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createDesignationSchema, { code: formString(fd, "code"), name: formString(fd, "name"), staffType: formString(fd, "staffType") }, async (ctx, d) => `Designation ${(await createDesignation(ctx, d))!.name} added.`);
}
export async function updateDesignationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateDesignationSchema, { ...ref(fd), code: formString(fd, "code"), name: formString(fd, "name"), staffType: formString(fd, "staffType") }, async (ctx, d) => (await updateDesignation(ctx, d), "Designation saved."));
}
export async function setDesignationActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setMasterActiveSchema, activeRef(fd), async (ctx, d) => (await setDesignationActive(ctx, d), d.active ? "Designation activated." : "Designation deactivated."));
}

// ───────────────────────────── Employees ─────────────────────────────

const address = (fd: FormData) => ({
  line1: formString(fd, "line1"),
  line2: formString(fd, "line2"),
  city: formString(fd, "city"),
  district: formString(fd, "district"),
  state: formString(fd, "state"),
  pinCode: formString(fd, "pinCode"),
  country: formString(fd, "country") || "India",
});
const emergency = (fd: FormData) => ({ name: formString(fd, "ecName"), relation: formString(fd, "ecRelation"), phone: formString(fd, "ecPhone") });
const personal = (fd: FormData) => ({
  firstName: formString(fd, "firstName"),
  middleName: formString(fd, "middleName"),
  lastName: formString(fd, "lastName"),
  dob: formString(fd, "dob"),
  gender: formString(fd, "gender"),
});
const contact = (fd: FormData) => ({
  personalPhone: formString(fd, "personalPhone"),
  workPhone: formString(fd, "workPhone"),
  personalEmail: formString(fd, "personalEmail"),
  workEmail: formString(fd, "workEmail"),
  address: address(fd),
  emergencyContact: emergency(fd),
});

export async function registerEmployeeAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    ...personal(fd),
    ...contact(fd),
    departmentId: formString(fd, "departmentId"),
    designationId: formString(fd, "designationId"),
    appointmentType: formString(fd, "appointmentType"),
    joiningDate: formString(fd, "joiningDate"),
    confirmationDate: formString(fd, "confirmationDate"),
    reportsToId: formString(fd, "reportsToId"),
  };
  let createdId: string | null = null;
  const state = await run(createEmployeeSchema, raw, async (ctx, d) => {
    const r = await registerEmployee(ctx, d);
    createdId = r.id;
    return `Registered with employee ID ${r.employeeCode}.`;
  });
  // Outside run(): redirect() throws a navigation signal that must not be mapped to an error.
  if (state.ok && createdId) redirect(`/erp/hr/employees/${createdId}?registered=1`);
  return state;
}

export async function updateEmployeePersonalAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateEmployeePersonalSchema, { ...ref(fd), ...personal(fd) }, async (ctx, d) => (await updateEmployeePersonal(ctx, d), "Personal details saved."));
}
export async function updateEmployeeContactAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateEmployeeContactSchema, { ...ref(fd), ...contact(fd) }, async (ctx, d) => (await updateEmployeeContact(ctx, d), "Contact details saved."));
}

// ───────────────────────────── Teacher profile & login account (M3) ─────────────────────────────

/** Repeated rows "prefix.<i>.<field>" → array of objects; fully blank rows are dropped (empty extra rows). */
function rows(fd: FormData, prefix: string, fields: readonly string[]): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (let i = 0; i < 20; i++) {
    const row = Object.fromEntries(fields.map((f) => [f, formString(fd, `${prefix}.${i}.${f}`)]));
    if (fields.some((f) => fd.has(`${prefix}.${i}.${f}`)) && fields.some((f) => row[f].trim() !== "")) out.push(row);
  }
  return out;
}

export async function saveTeacherProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const version = formString(fd, "version");
  const raw = {
    employeeId: formString(fd, "employeeId"),
    version: version === "" ? null : version,
    qualifications: rows(fd, "q", ["degree", "subject", "institution", "year"]),
    professionalQualifications: rows(fd, "pq", ["name", "year"]),
    specializations: formString(fd, "specializations")
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
    experienceYearsBefore: formString(fd, "experienceYearsBefore"),
    teacherRegistrationNo: formString(fd, "teacherRegistrationNo"),
  };
  return run(teacherProfileSchema, raw, async (ctx, d) => (await saveTeacherProfile(ctx, d), "Teacher profile saved."));
}

export async function linkStaffAccountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(linkAccountSchema, { employeeId: formString(fd, "employeeId"), userId: formString(fd, "userId") }, async (ctx, d) => `Linked to the account ${(await linkStaffAccount(ctx, d)).username}.`);
}

export async function unlinkStaffAccountAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(unlinkAccountSchema, { employeeId: formString(fd, "employeeId") }, async (ctx, d) => (await unlinkStaffAccount(ctx, d.employeeId), "Login account unlinked."));
}

// ───────────────────────────── Lifecycle (M4a) ─────────────────────────────

export async function changeEmploymentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    ...ref(fd),
    effectiveDate: formString(fd, "effectiveDate"),
    departmentId: formString(fd, "departmentId"),
    designationId: formString(fd, "designationId"),
    appointmentType: formString(fd, "appointmentType"),
    confirmationDate: formString(fd, "confirmationDate"),
    remarks: formString(fd, "remarks"),
  };
  return run(changeEmploymentSchema, raw, async (ctx, d) => {
    const { events } = await changeEmployment(ctx, d);
    return events === 0 ? "Nothing changed." : `Saved — ${events} change${events === 1 ? "" : "s"} recorded in the service history.`;
  });
}

export async function changeReportingAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { ...ref(fd), reportsToId: formString(fd, "reportsToId"), effectiveDate: formString(fd, "effectiveDate"), remarks: formString(fd, "remarks") };
  return run(changeReportingSchema, raw, async (ctx, d) => ((await changeReporting(ctx, d)).changed ? "Reporting line changed." : "Nothing changed."));
}

export async function changeStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { ...ref(fd), action: formString(fd, "action"), effectiveDate: formString(fd, "effectiveDate"), reason: formString(fd, "reason"), deactivateAccount: formString(fd, "deactivateAccount") === "on" };
  return run(changeStatusSchema, raw, async (ctx, d) => {
    const r = await changeStatus(ctx, d);
    const parts = ["Status saved."];
    if (r.sectionsReleased) parts.push(`${r.sectionsReleased} class-teacher section${r.sectionsReleased === 1 ? "" : "s"} released.`);
    if (r.accountDeactivated) parts.push("The login account was deactivated.");
    // H13: never a silent skip — say plainly that the login still works.
    if (r.accountStillActive) parts.push("The linked login account is still active: an administrator who manages users must deactivate it.");
    return parts.join(" ");
  });
}

// ───────────────────────────── Documents (M4b) ─────────────────────────────

const docRef = (fd: FormData) => ({ employeeId: formString(fd, "employeeId"), documentId: formString(fd, "documentId") });

export async function removeEmployeeDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(employeeDocumentRefSchema, docRef(fd), async (ctx, d) => (await removeEmployeeDocument(ctx, d.employeeId, d.documentId), "Document removed."));
}
export async function verifyEmployeeDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(employeeDocumentRefSchema, docRef(fd), async (ctx, d) => (await verifyEmployeeDocument(ctx, d.employeeId, d.documentId), "Document marked as verified."));
}
