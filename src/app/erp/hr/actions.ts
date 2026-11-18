"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  createDepartmentSchema,
  createDesignationSchema,
  createEmployeeSchema,
  setMasterActiveSchema,
  updateDepartmentSchema,
  updateDesignationSchema,
  updateEmployeeContactSchema,
  updateEmployeePersonalSchema,
} from "@/modules/hr/hr.schemas";
import { createDepartment, createDesignation, setDepartmentActive, setDesignationActive, updateDepartment, updateDesignation } from "@/modules/hr/master-data.service";
import { registerEmployee, updateEmployeeContact, updateEmployeePersonal } from "@/modules/hr/employees.service";

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
