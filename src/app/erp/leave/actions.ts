"use server";

import { revalidatePath } from "next/cache";
import type { z } from "zod";
import { requireAuth } from "@/lib/auth/context";
import {
  formString,
  fromError,
  fromZod,
  type ActionState,
} from "@/lib/action-state";
import type { AuthContext } from "@/lib/rbac/authorize";
import {
  applyForLeave,
  cancelLeave,
  decideLeave,
} from "@/modules/hr/leave-requests.service";
import {
  applyLeaveSchema,
  cancelLeaveSchema,
  decideLeaveSchema,
} from "@/modules/hr/leave.schemas";

/** Phase 3B M3 leave actions: parse → service → ActionState (services authorize and enforce every rule). */
async function run<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  call: (ctx: AuthContext, data: z.infer<S>) => Promise<string>,
): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const message = await call(ctx, parsed.data);
    revalidatePath("/erp/leave", "layout");
    revalidatePath("/erp/hr", "layout");
    return { ok: true, message };
  } catch (e) {
    return fromError(e);
  }
}

export async function applyForLeaveAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const halfDay = formString(fd, "halfDay");
  const raw = {
    leaveTypeId: formString(fd, "leaveTypeId"),
    fromDate: formString(fd, "fromDate"),
    toDate: formString(fd, "toDate") || formString(fd, "fromDate"),
    halfDay: halfDay === "" ? null : halfDay,
    reason: formString(fd, "reason"),
  };
  return run(applyLeaveSchema, raw, async (ctx, d) => {
    const r = await applyForLeave(ctx, d);
    return `Leave request sent for ${r.days} day(s). You'll see the decision here.`;
  });
}

export async function decideLeaveAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  const raw = {
    id: formString(fd, "id"),
    version: formString(fd, "version"),
    decision: formString(fd, "decision"),
    note: formString(fd, "note"),
  };
  return run(
    decideLeaveSchema,
    raw,
    async (ctx, d) => (
      await decideLeave(ctx, d),
      d.decision === "APPROVE" ? "Leave approved." : "Leave rejected."
    ),
  );
}

export async function cancelLeaveAction(
  _prev: ActionState,
  fd: FormData,
): Promise<ActionState> {
  return run(
    cancelLeaveSchema,
    { id: formString(fd, "id"), version: formString(fd, "version") },
    async (ctx, d) => (await cancelLeave(ctx, d), "Leave request cancelled."),
  );
}
