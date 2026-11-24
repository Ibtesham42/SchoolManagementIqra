"use server";

import { revalidatePath } from "next/cache";
import { requirePortal } from "@/lib/auth/context";
import { formString, fromError, fromZod, type ActionState } from "@/lib/action-state";
import { NotFoundError } from "@/lib/errors";
import { submitPortalClaim } from "@/modules/fees/payment-claims.portal";
import { submitClaimSchema } from "@/modules/fees/payment-claims.schemas";

/** Phase 6C-M3 (P19): a parent reports a UPI / bank-transfer payment. The service re-checks the child and the dues. */
export async function submitClaimAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requirePortal();
  const parsed = submitClaimSchema.safeParse({
    studentId: formString(fd, "studentId"),
    amount: formString(fd, "amount"),
    method: formString(fd, "method"),
    transactionRef: formString(fd, "transactionRef"),
    paidOn: formString(fd, "paidOn"),
  });
  if (!parsed.success) return fromZod(parsed.error);
  try {
    await submitPortalClaim(ctx, parsed.data);
  } catch (e) {
    if (e instanceof NotFoundError) return { error: "This page is no longer available. Go back to the portal home." };
    return fromError(e);
  }
  revalidatePath(`/portal/c/${encodeURIComponent(parsed.data.studentId)}/fees`, "layout");
  return { ok: true, message: "Thank you. The school will check the payment and confirm it. The receipt then appears in the Fees tab." };
}
