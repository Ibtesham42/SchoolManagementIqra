"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { ValidationError } from "@/lib/errors";
import { TABLE_LIMITS } from "@/lib/import/tabular";
import { enforce, RULES } from "@/lib/rate-limit";
import type { ImportPlan } from "@/modules/academic/marks-import.rules";
import { previewMarksImport } from "@/modules/academic/marks-import.service";
import { saveMarksSchema, sheetRefSchema } from "@/modules/academic/marks.schemas";
import { saveMarks } from "@/modules/academic/marks.service";

/** Phase 4C-M4: marks import — preview (reads the file, writes nothing) and confirm (through saveMarks). */
export interface ImportPreviewState extends ActionState {
  preview?: { mode: "enter" | "correct"; sheetVersion: number | null; plan: ImportPlan; canConfirm: boolean; fileName: string };
}

export async function previewMarksImportAction(_prev: ImportPreviewState, fd: FormData): Promise<ImportPreviewState> {
  const ctx = await requireAuth();
  const ref = sheetRefSchema.safeParse({ examSubjectId: formString(fd, "examSubjectId"), sectionId: formString(fd, "sectionId") });
  if (!ref.success) return fromZod(ref.error);
  try {
    await enforce(RULES.upload, ctx.userId);
    const files = fd.getAll("file").filter((v): v is File => typeof v !== "string");
    if (files.length !== 1 || files[0].size === 0) throw new ValidationError("Choose the filled-in .xlsx or .csv file.", [{ path: "file", message: "Choose a file." }]);
    const file = files[0];
    if (file.size > TABLE_LIMITS.maxBytes) throw new ValidationError(`The file is larger than ${TABLE_LIMITS.maxBytes / 1024} KB.`, [{ path: "file", message: "Too large." }]);
    const fileName = file.name.slice(0, 120);
    const r = await previewMarksImport(ctx, ref.data, { bytes: new Uint8Array(await file.arrayBuffer()), fileName });
    return { ok: true, preview: { mode: r.mode, sheetVersion: r.sheetVersion, plan: r.plan, canConfirm: r.canConfirm, fileName } };
  } catch (e) {
    return fromError(e);
  }
}

/** The grid's wire format: a blank part is "" (the schema turns it into null). */
function toFormEntries(v: unknown): unknown {
  if (!Array.isArray(v)) return v;
  return v.slice(0, 201).map((e: unknown) => {
    if (!e || typeof e !== "object") return e;
    const o = { ...(e as Record<string, unknown>) };
    for (const k of ["theory", "practical", "internal"]) if (o[k] === null) o[k] = "";
    return o;
  });
}

/** The planned entries come back as JSON; saveMarks re-checks every one under its locks (nothing is trusted). */
export async function confirmMarksImportAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  let entries: unknown;
  try {
    const raw = formString(fd, "entries");
    if (raw.length > 100_000) throw new Error("too long");
    entries = toFormEntries(JSON.parse(raw));
  } catch {
    return { error: "The import couldn't be read. Upload the file again." };
  }
  try {
    await enforce(RULES.upload, ctx.userId); // review 4C-M4 L2
  } catch (e) {
    return fromError(e);
  }
  const sheetVersion = formString(fd, "sheetVersion");
  const parsed = saveMarksSchema.safeParse({
    examSubjectId: formString(fd, "examSubjectId"),
    sectionId: formString(fd, "sectionId"),
    sheetVersion: sheetVersion === "" ? null : sheetVersion,
    reason: formString(fd, "reason"),
    entries,
    source: "import",
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return first?.path[0] === "reason" ? fromZod(parsed.error) : { error: "The import couldn't be checked. Upload the file again." };
  }
  try {
    const r = await saveMarks(ctx, parsed.data);
    revalidatePath("/erp/academic", "layout");
    return { ok: true, message: r.created + r.changed === 0 ? "Nothing changed." : `Imported: ${r.created} new, ${r.changed} changed.` };
  } catch (e) {
    return fromError(e);
  }
}
