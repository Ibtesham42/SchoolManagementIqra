"use server";

import { requireAuth } from "@/lib/auth/context";
import { fromError, type ActionState } from "@/lib/action-state";
import { revokeUserSessions } from "@/modules/identity/users.service";

export async function signOutOtherDevicesAction(): Promise<ActionState> {
  const ctx = await requireAuth();
  try {
    const count = await revokeUserSessions(ctx, ctx.userId, { keepCurrent: true });
    return { ok: true, message: count === 0 ? "No other devices were signed in." : `Signed out of ${count} other device${count === 1 ? "" : "s"}.` };
  } catch (e) {
    return fromError(e);
  }
}
