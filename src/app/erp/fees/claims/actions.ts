"use server";

import { revalidatePath } from "next/cache";
import { requireAuth } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { claimRefSchema, rejectClaimSchema } from "@/modules/fees/payment-claims.schemas";
import { confirmPaymentClaim, rejectPaymentClaim } from "@/modules/fees/payment-claims.service";

/** Phase 6C-M3 (P19): the Accountant confirms (→ an ordinary receipt) or rejects a parent's payment claim. */
export async function confirmClaimAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = claimRefSchema.safeParse({ id: formString(fd, "id"), version: formString(fd, "version") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    const r = await confirmPaymentClaim(ctx, parsed.data);
    revalidatePath("/erp/fees", "layout");
    return { ok: true, message: `Confirmed. Receipt ${r.receiptNo} issued.` };
  } catch (e) {
    return fromError(e);
  }
}

export async function rejectClaimAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireAuth();
  const parsed = rejectClaimSchema.safeParse({ id: formString(fd, "id"), version: formString(fd, "version"), reason: formString(fd, "reason") });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await rejectPaymentClaim(ctx, parsed.data);
    revalidatePath("/erp/fees", "layout");
    return { ok: true, message: "Rejected. The parent sees \"not confirmed\" and is asked to contact the office." };
  } catch (e) {
    return fromError(e);
  }
}
