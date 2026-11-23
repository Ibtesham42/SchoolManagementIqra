import type { ReactNode } from "react";
import { requirePortal } from "@/lib/auth/context";
import { ChildTabs } from "@/components/portal/child-tabs";
import { portalChildTabs, portalWindow } from "@/modules/students/students.portal";

/**
 * Phase 6B-M1 — the child pages' tab strip. The id in the URL is untrusted: it only builds links here; every page
 * re-checks access through its service (identical 404 for anything not this account's).
 */
export default async function ChildLayout({ children, params }: { children: ReactNode; params: Promise<{ studentId: string }> }) {
  const ctx = await requirePortal();
  const { studentId } = await params;
  // Review 6B-M1 L6: only the pages this account may open (a leaver keeps report cards and receipts only, P17).
  const tabs = ctx.mustChangePassword ? [] : portalChildTabs(ctx, studentId, await portalWindow());
  return (
    <>
      {tabs.length > 1 && <ChildTabs studentId={studentId} tabs={tabs} />}
      {children}
    </>
  );
}
