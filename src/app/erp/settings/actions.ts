"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { defaultSectionCapacitySchema } from "@/modules/academic/academic.schemas";
import { academicSessionSchema, schoolProfileSchema, sessionIdSchema, updateAcademicSessionSchema } from "@/modules/settings/settings.schemas";
import {
  changeAcademicSessionStatus,
  createAcademicSession,
  removeSchoolLogo,
  setCurrentAcademicSession,
  setSchoolLogo,
  updateAcademicSession,
  updateDefaultSectionCapacity,
  updateSchoolProfile,
  updatePayrollDayBasis,
} from "@/modules/settings/settings.service";

const refresh = () => {
  revalidatePath("/erp/settings");
  revalidatePath("/erp/settings/sessions");
};

export async function updateProfileAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schoolProfileSchema.safeParse({
    name: formString(fd, "name"),
    shortCode: formString(fd, "shortCode"),
    affiliationNo: formString(fd, "affiliationNo"),
    board: formString(fd, "board"),
    email: formString(fd, "email"),
    website: formString(fd, "website"),
    phones: ["phone1", "phone2", "phone3"].map((k) => formString(fd, k)).filter((v) => v.trim() !== ""),
    address: {
      line1: formString(fd, "line1"),
      line2: formString(fd, "line2"),
      city: formString(fd, "city"),
      district: formString(fd, "district"),
      state: formString(fd, "state"),
      pinCode: formString(fd, "pinCode"),
      country: formString(fd, "country") || "India",
    },
    timezone: formString(fd, "timezone"),
    locale: formString(fd, "locale") || undefined,
    currency: formString(fd, "currency") || undefined,
    dateFormat: formString(fd, "dateFormat") || undefined,
    timings: { opensAt: formString(fd, "opensAt"), closesAt: formString(fd, "closesAt"), officeHours: formString(fd, "officeHours") },
  });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await updateSchoolProfile(ctx, parsed.data);
    refresh();
    return { ok: true, message: "School profile saved." };
  } catch (e) {
    return fromError(e);
  }
}

export async function updateDefaultCapacityAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = defaultSectionCapacitySchema.safeParse({ defaultSectionCapacity: formString(fd, "defaultSectionCapacity") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await updateDefaultSectionCapacity(ctx, parsed.data.defaultSectionCapacity);
    refresh();
    revalidatePath("/erp/academic", "layout");
    return { ok: true, message: "Default section capacity saved. Existing sections keep their own capacity." };
  } catch (e) {
    return fromError(e);
  }
}

export async function uploadLogoAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const file = fd.get("logo");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a PNG or JPEG file.", fieldErrors: { file: "Choose a file." } };
  try {
    await setSchoolLogo(ctx, new Uint8Array(await file.arrayBuffer()), file.name);
    refresh();
    return { ok: true, message: "Logo updated." };
  } catch (e) {
    return fromError(e);
  }
}

export async function removeLogoAction(_prev: ActionState, _fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    await removeSchoolLogo(ctx);
    refresh();
    return { ok: true, message: "Logo removed." };
  } catch (e) {
    return fromError(e);
  }
}

export async function createSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = academicSessionSchema.safeParse({ name: formString(fd, "name"), startDate: formString(fd, "startDate"), endDate: formString(fd, "endDate") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const s = await createAcademicSession(ctx, parsed.data);
    refresh();
    return { ok: true, message: `Session ${s.name} created (planned).` };
  } catch (e) {
    return fromError(e);
  }
}

export async function updateSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = updateAcademicSessionSchema.safeParse({ id: formString(fd, "id"), name: formString(fd, "name"), startDate: formString(fd, "startDate"), endDate: formString(fd, "endDate") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const { id, ...rest } = parsed.data;
    await updateAcademicSession(ctx, id, rest);
    refresh();
    return { ok: true, message: "Session updated." };
  } catch (e) {
    return fromError(e);
  }
}

async function sessionStatus(fd: FormData, to: "ACTIVE" | "CLOSED", message: string): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = sessionIdSchema.safeParse({ id: formString(fd, "id") });
  if (!parsed.success) return { error: "Unknown session." };
  try {
    await changeAcademicSessionStatus(ctx, parsed.data.id, to);
    refresh();
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

export async function activateSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return sessionStatus(fd, "ACTIVE", "Session activated.");
}

export async function closeSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return sessionStatus(fd, "CLOSED", "Session closed. Its records are now read-only.");
}

export async function setCurrentSessionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = sessionIdSchema.safeParse({ id: formString(fd, "id") });
  if (!parsed.success) return { error: "Unknown session." };
  try {
    await setCurrentAcademicSession(ctx, parsed.data.id);
    refresh();
    return { ok: true, message: "Current session changed." };
  } catch (e) {
    return fromError(e);
  }
}

/** Phase 3C (P3): payroll proration basis. */
export async function updatePayrollDayBasisAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const value = formString(fd, "payrollDayBasis");
  if (value !== "WORKING_DAYS" && value !== "CALENDAR_DAYS") return { error: "Choose working days or calendar days.", fieldErrors: { payrollDayBasis: "Choose one." } };
  try {
    await updatePayrollDayBasis(ctx, value);
    revalidatePath("/erp/settings");
    return { ok: true, message: "Payroll basis saved. Payroll runs prepared from now on use it." };
  } catch (e) {
    return fromError(e);
  }
}
