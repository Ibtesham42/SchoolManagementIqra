"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { ValidationError } from "@/lib/errors";
import { TABLE_LIMITS } from "@/lib/import/tabular";
import { enforce, RULES } from "@/lib/rate-limit";
import type { OpeningPlan } from "@/modules/fees/opening-import.rules";
import { importOpeningBalances, previewOpeningImport } from "@/modules/fees/opening-balances.service";
import { openingImportSchema, openingRefSchema } from "@/modules/fees/opening.schemas";

/** Phase 5C-M3: previous dues — preview (reads the file, writes nothing) and confirm (the service re-checks everything). */
export interface OpeningPreviewState extends ActionState {
  preview?: { plan: OpeningPlan; canConfirm: boolean; fileName: string };
}

export async function previewOpeningAction(_prev: OpeningPreviewState, fd: FormData): Promise<OpeningPreviewState> {
  const ctx = await requireAuth();
  const ref = openingRefSchema.safeParse({ academicSessionId: formString(fd, "academicSessionId"), classId: formString(fd, "classId") });
  if (!ref.success) return fromZod(ref.error);
  try {
    await enforce(RULES.upload, ctx.userId);
    const files = fd.getAll("file").filter((v): v is File => typeof v !== "string");
    if (files.length !== 1 || files[0].size === 0) throw new ValidationError("Choose the filled-in .xlsx or .csv file.", [{ path: "file", message: "Choose a file." }]);
    const file = files[0];
    if (file.size > TABLE_LIMITS.maxBytes) throw new ValidationError(`The file is larger than ${TABLE_LIMITS.maxBytes / 1024} KB.`, [{ path: "file", message: "Too large." }]);
    const fileName = file.name.slice(0, 120);
    const r = await previewOpeningImport(ctx, ref.data, { bytes: new Uint8Array(await file.arrayBuffer()), fileName });
    return { ok: true, preview: { plan: r.plan, canConfirm: r.canConfirm, fileName } };
  } catch (e) {
    return fromError(e);
  }
}

/** The planned entries come back as JSON; nothing is trusted — the service re-checks each one under its locks. */
export async function confirmOpeningAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  let entries: unknown;
  try {
    const raw = formString(fd, "entries");
    if (raw.length > 60_000) throw new Error("too long");
    entries = JSON.parse(raw);
  } catch {
    return { error: "The import couldn't be read. Upload the file again." };
  }
  const parsed = openingImportSchema.safeParse({
    academicSessionId: formString(fd, "academicSessionId"),
    classId: formString(fd, "classId"),
    dueOn: formString(fd, "dueOn"),
    entries,
    expectedTotal: formString(fd, "expectedTotal"),
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return first?.path[0] === "dueOn" ? fromZod(parsed.error) : { error: "The import couldn't be checked. Upload the file again." };
  }
  try {
    await enforce(RULES.upload, ctx.userId);
    const r = await importOpeningBalances(ctx, parsed.data);
    revalidatePath("/erp/fees", "layout");
    return { ok: true, message: r.created === 0 ? "Nothing new to add: these students already have previous dues." : `Previous dues added for ${r.created} student${r.created === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} skipped: already added)` : ""}.` };
  } catch (e) {
    return fromError(e);
  }
}
