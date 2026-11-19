"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { markAttendanceDay } from "@/modules/hr/staff-attendance.service";
import { markDaySchema } from "@/modules/hr/staff-attendance.schemas";

/**
 * Phase 3B M4: mark or correct one day (parse → service → ActionState; the service authorizes and enforces every rule).
 * Form shape: `date`, `reason`, one `emp` per employee on the screen, and per employee `status:<id>`, `in:<id>`,
 * `out:<id>`, `ver:<id>` ("" = no saved row).
 */
export async function markAttendanceDayAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const ids = fd.getAll("emp").filter((v): v is string => typeof v === "string").slice(0, 501);
  const raw = {
    date: formString(fd, "date"),
    reason: formString(fd, "reason"),
    entries: ids.map((id) => {
      const ver = formString(fd, `ver:${id}`);
      return {
        employeeId: id,
        status: formString(fd, `status:${id}`),
        checkIn: formString(fd, `in:${id}`),
        checkOut: formString(fd, `out:${id}`),
        version: ver === "" ? null : ver,
      };
    }),
  };
  const parsed = markDaySchema.safeParse(raw);
  if (!parsed.success) {
    // Per-employee issues have no visible field to highlight: show the first one as the form message.
    const first = parsed.error.issues[0];
    const state = fromZod(parsed.error);
    return first?.path[0] === "entries" ? { ...state, error: first.message } : state;
  }
  try {
    const r = await markAttendanceDay(ctx, parsed.data);
    revalidatePath("/erp/staff-attendance", "layout");
    const parts = [
      r.created ? `${r.created} marked` : null,
      r.corrected ? `${r.corrected} corrected` : null,
      r.unchanged ? `${r.unchanged} unchanged` : null,
    ].filter(Boolean);
    return { ok: true, message: r.created + r.corrected === 0 ? "Nothing changed." : `Saved: ${parts.join(", ")}.` };
  } catch (e) {
    return fromError(e);
  }
}
