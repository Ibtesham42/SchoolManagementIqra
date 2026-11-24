import { prisma } from "@/lib/db";
import type { NotificationDraft } from "@/modules/notifications/notifications.service";
import { familyRecipientsOf } from "@/modules/students/family-recipients.tx";

/**
 * Phase 6C-M2 (P23): "a receipt was issued / cancelled" for the student's PARENT accounts (students never see fees,
 * P16). Built after the collection or cancellation committed. No amount, receipt number, method, reference or reason —
 * the Fees tab shows the details to whoever may see them. Dedupe `receipt:` / `receipt-cancel:<student>:<payment>`.
 */
export async function receiptNotifications(paymentId: string, kind: "issued" | "cancelled"): Promise<NotificationDraft[]> {
  const p = await prisma.feePayment.findUnique({ where: { id: paymentId }, select: { studentId: true, status: true } });
  if (!p || (kind === "issued" ? p.status !== "SUCCESS" : p.status !== "CANCELLED")) return [];
  const recipients = await familyRecipientsOf(prisma, [p.studentId], { students: false });
  return recipients.map((r) => ({
    userId: r.userId,
    type: kind === "issued" ? ("fee.receipt" as const) : ("fee.receipt_cancelled" as const),
    title: kind === "issued" ? "Fee receipt issued" : "Fee receipt cancelled",
    body: kind === "issued" ? `A fee receipt was issued for ${r.firstName}.` : `A fee receipt for ${r.firstName} was cancelled by the school.`,
    link: `/portal/c/${encodeURIComponent(r.studentId)}/fees`,
    dedupeKey: `${kind === "issued" ? "receipt" : "receipt-cancel"}:${r.studentId}:${paymentId}`,
  }));
}
