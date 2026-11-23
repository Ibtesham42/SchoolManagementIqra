"use server";

import { requirePortal } from "@/lib/auth/context";
import { fromError, type ActionState } from "@/lib/action-state";
import { revokeUserSessions } from "@/modules/identity/users.service";

/** Sign this portal account out everywhere except the current device (own account only). */
export async function signOutOtherDevicesAction(): Promise<ActionState> {
  const ctx = await requirePortal();
  try {
    const count = await revokeUserSessions(ctx, ctx.userId, { keepCurrent: true });
    return { ok: true, message: count === 0 ? "No other devices were signed in." : `Signed out of ${count} other device${count === 1 ? "" : "s"}.` };
  } catch (e) {
    return fromError(e);
  }
}
