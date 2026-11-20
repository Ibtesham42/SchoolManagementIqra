"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  assignClassTeacherSchema,
  copySectionsSchema,
  createClassSchema,
  createSectionsBulkSchema,
  recordRefSchema,
  setActiveSchema,
  splitSectionNames,
  updateClassSchema,
  updateSectionSchema,
} from "@/modules/academic/academic.schemas";
import { createClass, setClassActive, updateClass } from "@/modules/academic/classes.service";
import {
  addClassSubjectsSchema,
  classSubjectRefSchema,
  copyClassSubjectsSchema,
  updateClassSubjectSchema,
} from "@/modules/academic/class-subjects.schemas";
import { addClassSubjects, copyClassSubjects, removeClassSubject, updateClassSubject } from "@/modules/academic/class-subjects.service";
import { allocationRefSchema, assignTeacherSchema } from "@/modules/academic/allocations.schemas";
import { assignTeacher, removeAllocation } from "@/modules/academic/allocations.service";
import { createSubjectSchema, setSubjectActiveSchema, updateSubjectSchema } from "@/modules/academic/subjects.schemas";
import { copyDayPlanSchema, saveDayPlanSchema, setSlotSchema } from "@/modules/academic/timetable.schemas";
import { copyDayPlan, saveDayPlan, setSlot } from "@/modules/academic/timetable.service";
import { setSubjectChoicesSchema } from "@/modules/students/subject-choices.schemas";
import { markStudentDaySchema } from "@/modules/students/student-attendance.schemas";
import { markStudentDay } from "@/modules/students/student-attendance.service";
import { setSubjectChoices } from "@/modules/students/subject-choices.service";
import { createSubject, setSubjectActive, updateSubject } from "@/modules/academic/subjects.service";
import { createScaleSchema, setScaleActiveSchema, updateScaleSchema } from "@/modules/academic/grading.schemas";
import { createCbseStyleScale, createScale, setScaleActive, updateScale } from "@/modules/academic/grading.service";
import {
  addExamSubjectsSchema,
  createExamSchema,
  examStatusSchema,
  examSubjectRefSchema,
  updateExamSchema,
  updateExamSubjectSchema,
} from "@/modules/academic/examinations.schemas";
import { addExamSubjects, createExam, deleteExam, removeExamSubject, setExamStatus, updateExam, updateExamSubject } from "@/modules/academic/examinations.service";
import { examRefSchema, reportCardRemarkSchema, saveMarksSchema, sheetActionSchema } from "@/modules/academic/marks.schemas";
import { lockExamMarks, saveMarks, sheetAction, unlockExamMarks } from "@/modules/academic/marks.service";
import { publishResults, setReportCardRemark } from "@/modules/academic/results.service";
import { createHomeworkSchema, homeworkRefSchema, updateHomeworkSchema } from "@/modules/academic/homework.schemas";
import { createHomework, removeHomework, updateHomework } from "@/modules/academic/homework.service";
import { createEventSchema, eventRefSchema, updateEventSchema } from "@/modules/academic/calendar.schemas";
import { createEvent, deleteEvent, updateEvent } from "@/modules/academic/calendar.service";
import { confirmPromotionsSchema, proposePromotionsSchema } from "@/modules/students/promotion.schemas";
import { confirmPromotions, proposePromotions } from "@/modules/students/promotion.service";
import {
  assignClassTeacher,
  copySectionsFromSession,
  createSectionsBulk,
  deleteSection,
  setSectionActive,
  unassignClassTeacher,
  updateSection,
} from "@/modules/academic/sections.service";

const refresh = () => revalidatePath("/erp/academic", "layout");

/** requireAuth → Zod parse → service → refresh; every error becomes a safe ActionState. */
async function run<S extends z.ZodType>(schema: S, raw: unknown, call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    refresh();
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

const classFields = (fd: FormData) => ({
  code: formString(fd, "code"),
  name: formString(fd, "name"),
  numericLevel: formString(fd, "numericLevel"),
  displayOrder: formString(fd, "displayOrder"),
  defaultSectionCapacity: formString(fd, "defaultSectionCapacity"),
});
const ref = (fd: FormData) => ({ id: formString(fd, "id"), version: formString(fd, "version") });

export async function createClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createClassSchema, classFields(fd), async (ctx, d) => `Class ${(await createClass(ctx, d)).name} created.`);
}

export async function updateClassAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateClassSchema, { ...ref(fd), ...classFields(fd) }, async (ctx, d) => (await updateClass(ctx, d), "Class saved."));
}

export async function setClassActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setClassActive(ctx, d.id, d.version, d.active);
    return d.active ? "Class activated." : "Class deactivated. It gets no new sections; existing sections are unchanged.";
  });
}

export async function createSectionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = { academicSessionId: formString(fd, "academicSessionId"), classId: formString(fd, "classId"), names: splitSectionNames(formString(fd, "names")), capacity: formString(fd, "capacity") };
  return run(createSectionsBulkSchema, raw, async (ctx, d) => {
    const created = await createSectionsBulk(ctx, d);
    return created.length === 1 ? `Section ${created[0].name} created.` : `${created.length} sections created: ${created.map((s) => s.name).join(", ")}.`;
  });
}

export async function updateSectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateSectionSchema, { ...ref(fd), name: formString(fd, "name"), capacity: formString(fd, "capacity") }, async (ctx, d) => (await updateSection(ctx, d), "Section saved."));
}

export async function setSectionActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setSectionActive(ctx, d.id, d.version, d.active);
    return d.active ? "Section activated." : "Section deactivated. It accepts no new enrolments.";
  });
}

export async function deleteSectionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await deleteSection(ctx, d.id, d.version), "Section deleted."));
}

export async function assignClassTeacherAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(assignClassTeacherSchema, { ...ref(fd), userId: formString(fd, "userId") }, async (ctx, d) => (await assignClassTeacher(ctx, d), "Class teacher assigned."));
}

export async function unassignClassTeacherAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(recordRefSchema, ref(fd), async (ctx, d) => (await unassignClassTeacher(ctx, d.id, d.version), "Class teacher removed."));
}

export async function copySectionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(copySectionsSchema, { fromSessionId: formString(fd, "fromSessionId"), toSessionId: formString(fd, "toSessionId") }, async (ctx, d) => {
    const r = await copySectionsFromSession(ctx, d);
    return `${r.created} section${r.created === 1 ? "" : "s"} copied${r.skipped ? `, ${r.skipped} already existed` : ""}. Class teachers were not copied.`;
  });
}

// ───────────────────────────── Phase 4A-M2: subjects ─────────────────────────────

const subjectFields = (fd: FormData) => ({ code: formString(fd, "code"), name: formString(fd, "name"), kind: formString(fd, "kind") });

export async function createSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createSubjectSchema, subjectFields(fd), async (ctx, d) => `Subject ${(await createSubject(ctx, d))!.name} added.`);
}

export async function updateSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateSubjectSchema, { ...ref(fd), ...subjectFields(fd) }, async (ctx, d) => (await updateSubject(ctx, d), "Subject saved."));
}

export async function setSubjectActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setSubjectActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setSubjectActive(ctx, d);
    return d.active ? "Subject activated." : "Subject deactivated. It can't be added to classes; existing classes keep it.";
  });
}

// ───────────────────────────── Phase 4A-M2: class subjects ─────────────────────────────

export async function addClassSubjectsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    academicSessionId: formString(fd, "academicSessionId"),
    classId: formString(fd, "classId"),
    subjectIds: fd.getAll("subjectIds").filter((v): v is string => typeof v === "string").slice(0, 31),
    isOptional: formString(fd, "isOptional"),
  };
  return run(addClassSubjectsSchema, raw, async (ctx, d) => {
    const r = await addClassSubjects(ctx, d);
    return `${r.added} subject${r.added === 1 ? "" : "s"} added${d.isOptional ? " as optional" : ""}.`;
  });
}

export async function updateClassSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateClassSubjectSchema, { ...ref(fd), isOptional: formString(fd, "isOptional"), sortOrder: formString(fd, "sortOrder") }, async (ctx, d) => (await updateClassSubject(ctx, d), "Saved."));
}

export async function removeClassSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(classSubjectRefSchema, ref(fd), async (ctx, d) => (await removeClassSubject(ctx, d), "Subject removed from the class."));
}

export async function copyClassSubjectsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(copyClassSubjectsSchema, { fromSessionId: formString(fd, "fromSessionId"), toSessionId: formString(fd, "toSessionId") }, async (ctx, d) => {
    const r = await copyClassSubjects(ctx, d);
    return `${r.created} class subject${r.created === 1 ? "" : "s"} copied${r.skipped ? `, ${r.skipped} already existed` : ""}.`;
  });
}

// ───────────────────────────── Phase 4A-M2: teacher allocation ─────────────────────────────

export async function assignTeacherAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const version = formString(fd, "version");
  const raw = { sectionId: formString(fd, "sectionId"), classSubjectId: formString(fd, "classSubjectId"), employeeId: formString(fd, "employeeId"), version: version === "" ? null : version };
  return run(assignTeacherSchema, raw, async (ctx, d) => (await assignTeacher(ctx, d), "Teacher allocated."));
}

export async function removeAllocationAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(allocationRefSchema, ref(fd), async (ctx, d) => (await removeAllocation(ctx, d), "Allocation removed."));
}

// ───────────────────────────── Phase 4A-M2: optional subjects per student ─────────────────────────────

export async function setSubjectChoicesAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const raw = {
    sectionId: formString(fd, "sectionId"),
    classSubjectId: formString(fd, "classSubjectId"),
    enrollmentIds: fd.getAll("enrollmentIds").filter((v): v is string => typeof v === "string").slice(0, 201),
    expectedIds: fd.getAll("expectedIds").filter((v): v is string => typeof v === "string").slice(0, 201),
  };
  return run(setSubjectChoicesSchema, raw, async (ctx, d) => {
    const r = await setSubjectChoices(ctx, d);
    return r.added + r.removed === 0 ? "Nothing changed." : `Saved: ${r.added} added, ${r.removed} removed.`;
  });
}

// ───────────────────────────── Phase 4A-M3: period plan and timetable ─────────────────────────────

export async function saveDayPlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const starts = fd.getAll("startTime").slice(0, 16);
  const ends = fd.getAll("endTime");
  const kinds = fd.getAll("kind");
  const labels = fd.getAll("label");
  const raw = {
    academicSessionId: formString(fd, "academicSessionId"),
    dayOfWeek: formString(fd, "dayOfWeek"),
    fingerprint: formString(fd, "fingerprint"),
    periods: starts.map((s, i) => ({ startTime: s, endTime: ends[i] ?? "", kind: kinds[i] ?? "", label: labels[i] ?? "" })),
  };
  return run(saveDayPlanSchema, raw, async (ctx, d) => {
    const r = await saveDayPlan(ctx, d);
    return r.created + r.updated + r.removed === 0 ? "Nothing changed." : `Saved: ${r.created} added, ${r.updated} changed, ${r.removed} removed.`;
  });
}

export async function copyDayPlanAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const fingerprints = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), formString(fd, `fp:${d}`)]));
  const raw = { academicSessionId: formString(fd, "academicSessionId"), fromDay: formString(fd, "fromDay"), toDays: fd.getAll("toDays").slice(0, 7), fingerprints };
  return run(copyDayPlanSchema, raw, async (ctx, d) => {
    const r = await copyDayPlan(ctx, d);
    return `${r.periods} period${r.periods === 1 ? "" : "s"} copied to ${r.days} day${r.days === 1 ? "" : "s"}.`;
  });
}

export async function setSlotAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const cs = formString(fd, "classSubjectId");
  const v = formString(fd, "version");
  const raw = { sectionId: formString(fd, "sectionId"), periodId: formString(fd, "periodId"), classSubjectId: cs === "" ? null : cs, version: v === "" ? null : v };
  return run(setSlotSchema, raw, async (ctx, d) => {
    const r = await setSlot(ctx, d);
    if (!r.changed) return "Nothing changed.";
    if (d.classSubjectId === null) return "Period cleared.";
    return "teacherAssigned" in r && r.teacherAssigned ? "Saved." : "Saved. No teacher is allocated to this subject in this section yet.";
  });
}

// ───────────────────────────── Phase 4A-M4: student attendance ─────────────────────────────

export async function markStudentDayAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ids = fd.getAll("enr").filter((v): v is string => typeof v === "string").slice(0, 201);
  const raw = {
    sectionId: formString(fd, "sectionId"),
    date: formString(fd, "date"),
    reason: formString(fd, "reason"),
    entries: ids.map((id) => {
      const v = formString(fd, `ver:${id}`);
      return { enrollmentId: id, status: formString(fd, `st:${id}`), version: v === "" ? null : v };
    }),
  };
  const ctx = await requireAuth();
  const parsed = markStudentDaySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const state = fromZod(parsed.error);
    return first?.path[0] === "entries" ? { ...state, error: first.message } : state;
  }
  try {
    const r = await markStudentDay(ctx, parsed.data);
    refresh();
    return { ok: true, message: r.created + r.changed === 0 ? "Nothing changed." : `Saved: ${r.created} marked, ${r.changed} changed.` };
  } catch (e) {
    return fromError(e);
  }
}

// ───────────────────────────── Phase 4B-M2: grading scales ─────────────────────────────

/** Band rows arrive as band-<i>-{min,grade,point,remark}; fully blank rows are skipped (the form shows spare rows). */
const MAX_BAND_ROWS = 20;
function bandRows(fd: FormData) {
  const rows = [];
  for (let i = 0; i < MAX_BAND_ROWS; i++) {
    const row = { minPercent: formString(fd, `band-${i}-min`), grade: formString(fd, `band-${i}-grade`), gradePoint: formString(fd, `band-${i}-point`), remark: formString(fd, `band-${i}-remark`) };
    if (Object.values(row).some((v) => v.trim() !== "")) rows.push(row);
  }
  return rows;
}

export async function createScaleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createScaleSchema, { name: formString(fd, "name"), bands: bandRows(fd) }, async (ctx, d) => `Grading scale ${(await createScale(ctx, d)).name} created.`);
}

export async function createCbseStyleScaleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  void fd;
  const ctx = await requireAuth();
  try {
    const s = await createCbseStyleScale(ctx);
    refresh();
    return { ok: true, message: `Grading scale ${s.name} created. Check the bands before using it.` };
  } catch (e) {
    return fromError(e);
  }
}

export async function updateScaleAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateScaleSchema, { ...ref(fd), name: formString(fd, "name"), bands: bandRows(fd) }, async (ctx, d) => (await updateScale(ctx, d), "Grading scale saved."));
}

export async function setScaleActiveAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(setScaleActiveSchema, { ...ref(fd), active: formString(fd, "active") === "true" }, async (ctx, d) => {
    await setScaleActive(ctx, d);
    return d.active ? "Grading scale activated." : "Grading scale deactivated. New exams can't use it; existing exams keep it.";
  });
}

// ───────────────────────────── Phase 4B-M3: examinations ─────────────────────────────

const examFields = (fd: FormData) => ({
  name: formString(fd, "name"),
  gradeScaleId: formString(fd, "gradeScaleId"),
  startDate: formString(fd, "startDate"),
  endDate: formString(fd, "endDate"),
});
const examSubjectFields = (fd: FormData) => ({
  examDate: formString(fd, "examDate"),
  maxTheory: formString(fd, "maxTheory"),
  maxPractical: formString(fd, "maxPractical"),
  maxInternal: formString(fd, "maxInternal"),
  passPercent: formString(fd, "passPercent"),
});

export async function createExamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createExamSchema, { academicSessionId: formString(fd, "academicSessionId"), ...examFields(fd) }, async (ctx, d) => `Exam ${(await createExam(ctx, d)).name} created. Add its subjects next.`);
}

export async function updateExamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateExamSchema, { ...ref(fd), ...examFields(fd) }, async (ctx, d) => (await updateExam(ctx, d), "Exam saved."));
}

const STATUS_MESSAGE: Record<string, string> = {
  DRAFT: "Exam moved back to draft.",
  SCHEDULED: "Exam scheduled. Its grading scale is now fixed.",
  MARKS_ENTRY: "Marks entry is open. Teachers can now enter marks for their subjects.",
};
export async function setExamStatusAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examStatusSchema, { ...ref(fd), to: formString(fd, "to") }, async (ctx, d) => (await setExamStatus(ctx, d), STATUS_MESSAGE[d.to]));
}

export async function deleteExamAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examSubjectRefSchema, ref(fd), async (ctx, d) => (await deleteExam(ctx, d), "Draft exam deleted."));
}

export async function addExamSubjectsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ids = fd.getAll("classSubjectId").filter((v): v is string => typeof v === "string").slice(0, 101);
  return run(
    addExamSubjectsSchema,
    { examinationId: formString(fd, "examinationId"), version: formString(fd, "version"), classSubjectIds: ids, ...examSubjectFields(fd) },
    async (ctx, d) => `${await addExamSubjects(ctx, d)} subject(s) added.`,
  );
}

export async function updateExamSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateExamSubjectSchema, { ...ref(fd), ...examSubjectFields(fd) }, async (ctx, d) => (await updateExamSubject(ctx, d), "Subject saved."));
}

export async function removeExamSubjectAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examSubjectRefSchema, ref(fd), async (ctx, d) => (await removeExamSubject(ctx, d), "Subject removed from the exam."));
}

// ───────────────────────────── Phase 4B-M4/M5: marks ─────────────────────────────

/** Grid rows arrive as enr=<id> plus st:/th:/pr:/in:/ver:<id>. */
export async function saveMarksAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ids = fd.getAll("enr").filter((v): v is string => typeof v === "string").slice(0, 201);
  const sheetVersion = formString(fd, "sheetVersion");
  const raw = {
    examSubjectId: formString(fd, "examSubjectId"),
    sectionId: formString(fd, "sectionId"),
    sheetVersion: sheetVersion === "" ? null : sheetVersion,
    reason: formString(fd, "reason"),
    entries: ids.map((id) => {
      const v = formString(fd, `ver:${id}`);
      return { enrollmentId: id, status: formString(fd, `st:${id}`), theory: formString(fd, `th:${id}`), practical: formString(fd, `pr:${id}`), internal: formString(fd, `in:${id}`), version: v === "" ? null : v };
    }),
  };
  const ctx = await requireAuth();
  const parsed = saveMarksSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const state = fromZod(parsed.error);
    return first?.path[0] === "entries" ? { ...state, error: first.message } : state;
  }
  try {
    const r = await saveMarks(ctx, parsed.data);
    refresh();
    return { ok: true, message: r.created + r.changed === 0 ? "Nothing changed." : `Saved: ${r.created} new, ${r.changed} changed.` };
  } catch (e) {
    return fromError(e);
  }
}

const SHEET_MESSAGE = { submit: "Marks submitted for approval.", return: "Marks returned to the teacher for changes.", approve: "Marks approved." } as const;
export async function sheetActionAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(
    sheetActionSchema,
    { examSubjectId: formString(fd, "examSubjectId"), sectionId: formString(fd, "sectionId"), sheetVersion: formString(fd, "sheetVersion"), action: formString(fd, "action") },
    async (ctx, d) => (await sheetAction(ctx, d), SHEET_MESSAGE[d.action]),
  );
}

export async function lockExamMarksAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examRefSchema, ref(fd), async (ctx, d) => (await lockExamMarks(ctx, d), "Marks locked. Results can now be published."));
}

export async function unlockExamMarksAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examRefSchema, ref(fd), async (ctx, d) => (await unlockExamMarks(ctx, d), "Marks entry reopened."));
}

// ───────────────────────────── Phase 4B-M6: results ─────────────────────────────

export async function publishResultsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(examRefSchema, ref(fd), async (ctx, d) => {
    const r = await publishResults(ctx, d);
    return `Results published: ${r.reportCards} report card(s), ${r.passed} passed.`;
  });
}

export async function reportCardRemarkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(reportCardRemarkSchema, { ...ref(fd), remark: formString(fd, "remark") }, async (ctx, d) => (await setReportCardRemark(ctx, d), "Remark saved."));
}

// ───────────────────────────── Phase 4C-M2: homework ─────────────────────────────

const homeworkFields = (fd: FormData) => ({ title: formString(fd, "title"), details: formString(fd, "details"), dueOn: formString(fd, "dueOn") });

export async function createHomeworkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createHomeworkSchema, { sectionId: formString(fd, "sectionId"), classSubjectId: formString(fd, "classSubjectId"), ...homeworkFields(fd) }, async (ctx, d) => (await createHomework(ctx, d), "Homework posted."));
}

export async function updateHomeworkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateHomeworkSchema, { ...ref(fd), ...homeworkFields(fd) }, async (ctx, d) => (await updateHomework(ctx, d), "Homework saved."));
}

export async function removeHomeworkAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(homeworkRefSchema, ref(fd), async (ctx, d) => (await removeHomework(ctx, d), "Homework removed."));
}

// ───────────────────────────── Phase 4C-M3: academic calendar ─────────────────────────────

const eventFields = (fd: FormData) => ({ title: formString(fd, "title"), startDate: formString(fd, "startDate"), endDate: formString(fd, "endDate"), details: formString(fd, "details") });

export async function createEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(createEventSchema, { academicSessionId: formString(fd, "academicSessionId"), ...eventFields(fd) }, async (ctx, d) => (await createEvent(ctx, d), "Event added to the calendar."));
}

export async function updateEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(updateEventSchema, { ...ref(fd), ...eventFields(fd) }, async (ctx, d) => (await updateEvent(ctx, d), "Event saved."));
}

export async function deleteEventAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  return run(eventRefSchema, ref(fd), async (ctx, d) => (await deleteEvent(ctx, d), "Event removed."));
}

// ───────────────────────────── Phase 4C-M1: promotion ─────────────────────────────

/** Rows arrive as enr=<id> plus dec:/cls:/leave:/ver:<id>. */
export async function proposePromotionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ids = fd.getAll("enr").filter((v): v is string => typeof v === "string").slice(0, 201);
  const raw = {
    sectionId: formString(fd, "sectionId"),
    entries: ids.map((id) => {
      const v = formString(fd, `ver:${id}`);
      return { enrollmentId: id, decision: formString(fd, `dec:${id}`), toClassId: formString(fd, `cls:${id}`), leaveAs: formString(fd, `leave:${id}`), version: v === "" ? null : v };
    }),
  };
  const ctx = await requireAuth();
  const parsed = proposePromotionsSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const state = fromZod(parsed.error);
    return first?.path[0] === "entries" ? { ...state, error: first.message } : state;
  }
  try {
    const r = await proposePromotions(ctx, parsed.data);
    refresh();
    return { ok: true, message: `Proposals saved: ${r.created} new, ${r.changed} changed.` };
  } catch (e) {
    return fromError(e);
  }
}

export async function confirmPromotionsAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const targets = fd
    .getAll("targetClass")
    .filter((v): v is string => typeof v === "string")
    .slice(0, 21)
    .map((classId) => ({ classId, sectionId: formString(fd, `target:${classId}`) }))
    .filter((t) => t.sectionId !== "");
  return run(confirmPromotionsSchema, { sectionId: formString(fd, "sectionId"), targetSessionId: formString(fd, "targetSessionId"), targets }, async (ctx, d) => {
    const r = await confirmPromotions(ctx, d);
    return `Confirmed: ${r.promoted} promoted, ${r.detained} detained, ${r.left} left. Generate roll numbers in the new session's sections next.`;
  });
}
