import { redirect } from "next/navigation";
import { requirePortal } from "@/lib/auth/context";

/** `/portal/c/<id>` opens the child's profile (the profile page re-checks access). */
export default async function PortalChildIndex({ params }: { params: Promise<{ studentId: string }> }) {
  await requirePortal();
  const { studentId } = await params;
  redirect(`/portal/c/${encodeURIComponent(studentId)}/profile`);
}
