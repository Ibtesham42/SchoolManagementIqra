"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import { documentRefSchema } from "@/modules/admissions/documents.schemas";
import { removeApplicationDocument, verifyApplicationDocument } from "@/modules/admissions/documents.service";
import {
  approveSchema,
  contactStepSchema,
  createDraftSchema,
  guardiansStepSchema,
  previousSchoolStepSchema,
  reasonSchema,
  recordRefSchema,
  setSectionSchema,
  updateStudentStepSchema,
} from "@/modules/admissions/admissions.schemas";
import {
  approveApplication,
  createDraft,
  deleteDraft,
  rejectApplication,
  returnToDraft,
  setSection,
  startReview,
  submitApplication,
  updateContactStep,
  updateGuardiansStep,
  updatePreviousSchoolStep,
  updateStudentStep,
} from "@/modules/admissions/admissions.service";

/**
 * Admission server actions: requireAuth → Zod parse → service → refresh/redirect. The services
 * authorize and re-validate everything; these only shape form data. Redirects happen after the
 * try/catch so Next.js navigation is never swallowed.
 */
type Outcome = { redirectTo: string } | { message: string };

async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<Outcome>, mapErrors?: (fe: Record<string, string>) => Record<string, string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const state = fromZod(parsed.error);
    return mapErrors && state.fieldErrors ? { ...state, fieldErrors: mapErrors(state.fieldErrors) } : state;
  }
  let outcome: Outcome;
  try {
    outcome = await call(ctx, parsed.data);
  } catch (e) {
    return fromError(e);
  }
  revalidatePath("/erp/admissions", "layout");
  if ("redirectTo" in outcome) redirect(outcome.redirectTo);
  return { ok: true, message: outcome.message };
}

const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });
const studentFields = (fd: FormData) => ({
  academicSessionId: formString(fd, "academicSessionId"),
  classId: formString(fd, "classId"),
  firstName: formString(fd, "firstName"),
  middleName: formString(fd, "middleName"),
  lastName: formString(fd, "lastName"),
  dob: formString(fd, "dob"),
  gender: formString(fd, "gender"),
});
const stepUrl = (id: string, step: number) => `/erp/admissions/${id}/edit?step=${step}`;

export async function createDraftAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createDraftSchema, studentFields(fd), async (ctx, d) => ({ redirectTo: stepUrl((await createDraft(ctx, d)).id, 2) }));
}

export async function saveStudentStepAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateStudentStepSchema, { ...ref(fd), ...studentFields(fd) }, async (ctx, d) => (await updateStudentStep(ctx, d), { redirectTo: stepUrl(d.id, 2) }));
}

/** Guardian slots: 0 = father, 1 = mother, 2 = guardian/other. A slot counts once it has a name or phone. */
export async function saveGuardiansStepAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const relations = ["FATHER", "MOTHER", formString(fd, "g2_relation") || "GUARDIAN"];
  const primary = formString(fd, "primary");
  const slots = [0, 1, 2].filter((i) => formString(fd, `g${i}_name`).trim() !== "" || formString(fd, `g${i}_phone`).trim() !== "");
  const guardians = slots.map((i) => ({
    relation: relations[i],
    name: formString(fd, `g${i}_name`),
    phone: formString(fd, `g${i}_phone`),
    altPhone: formString(fd, `g${i}_altPhone`),
    email: formString(fd, `g${i}_email`),
    occupation: formString(fd, `g${i}_occupation`),
    isPrimary: primary === String(i),
    isEmergencyContact: fd.get(`g${i}_emergency`) === "on",
  }));
  // Zod reports guardians.<index in the list>.<field>; the form shows errors per slot.
  const mapErrors = (fe: Record<string, string>) =>
    Object.fromEntries(Object.entries(fe).map(([k, v]) => {
      const m = /^guardians\.(\d+)\.(\w+)$/.exec(k);
      return m ? [`g${slots[Number(m[1])]}.${m[2]}`, v] : [k, v];
    }));
  return run(guardiansStepSchema, { ...ref(fd), guardians }, async (ctx, d) => (await updateGuardiansStep(ctx, d), { redirectTo: stepUrl(d.id, 3) }), mapErrors);
}

export async function saveContactStepAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const address = {
    line1: formString(fd, "line1"),
    line2: formString(fd, "line2"),
    city: formString(fd, "city"),
    district: formString(fd, "district"),
    state: formString(fd, "state"),
    pinCode: formString(fd, "pinCode"),
    country: formString(fd, "country") || "India",
  };
  return run(contactStepSchema, { ...ref(fd), phone: formString(fd, "phone"), email: formString(fd, "email"), address }, async (ctx, d) => (await updateContactStep(ctx, d), { redirectTo: stepUrl(d.id, 4) }));
}

export async function savePreviousSchoolStepAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const previousSchool = {
    name: formString(fd, "schoolName"),
    board: formString(fd, "board"),
    lastClass: formString(fd, "lastClass"),
    yearLeft: formString(fd, "yearLeft"),
    tcNumber: formString(fd, "tcNumber"),
  };
  return run(previousSchoolStepSchema, { ...ref(fd), previousSchool }, async (ctx, d) => (await updatePreviousSchoolStep(ctx, d), { redirectTo: stepUrl(d.id, 5) }));
}

export async function submitApplicationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await submitApplication(ctx, d.id, d.version), { redirectTo: `/erp/admissions/${d.id}?submitted=1` }));
}

export async function deleteDraftAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await deleteDraft(ctx, d.id, d.version), { redirectTo: "/erp/admissions?deleted=1" }));
}

export async function startReviewAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await startReview(ctx, d.id, d.version), { message: "Review started." }));
}

export async function setSectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setSectionSchema, { ...ref(fd), sectionId: formString(fd, "sectionId") }, async (ctx, d) => (await setSection(ctx, d.id, d.version, d.sectionId), { message: "Section saved." }));
}

export async function returnToDraftAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(reasonSchema, { ...ref(fd), reason: formString(fd, "reason") }, async (ctx, d) => (await returnToDraft(ctx, d.id, d.version, d.reason), { message: "Returned to draft for corrections." }));
}

export async function removeDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(documentRefSchema, { applicationId: formString(fd, "applicationId"), documentId: formString(fd, "documentId") }, async (ctx, d) => (await removeApplicationDocument(ctx, d.applicationId, d.documentId), { message: "Document removed." }));
}

export async function verifyDocumentAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(documentRefSchema, { applicationId: formString(fd, "applicationId"), documentId: formString(fd, "documentId") }, async (ctx, d) => (await verifyApplicationDocument(ctx, d.applicationId, d.documentId), { message: "Document marked as verified." }));
}

export async function rejectApplicationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(reasonSchema, { ...ref(fd), reason: formString(fd, "reason") }, async (ctx, d) => (await rejectApplication(ctx, d.id, d.version, d.reason), { message: "Application rejected." }));
}

/** Approve = register (D1). Guardian choices arrive as `link_<applicationGuardianId>` = "new" | <guardian id> (D9). */
export async function approveApplicationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const guardianLinks: Record<string, string | null> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("link_") && typeof v === "string") guardianLinks[k.slice(5)] = v === "new" || v === "" ? null : v;
  }
  return run(
    approveSchema,
    { ...ref(fd), admissionDate: formString(fd, "admissionDate"), duplicateOverride: formString(fd, "duplicateOverride"), guardianLinks },
    async (ctx, d) => {
      const r = await approveApplication(ctx, d);
      return { message: `Approved. Student ${r.studentCode} registered with admission number ${r.admissionNo}.` };
    },
  );
}
