import Link from "next/link";
import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, type AdmissionStatus } from "@/modules/admissions/admissions.rules";

/** Server-rendered pieces shared by the admission pages (no client state). */
const VARIANT: Record<AdmissionStatus, "outline" | "secondary" | "default" | "destructive"> = {
  DRAFT: "outline",
  SUBMITTED: "secondary",
  UNDER_REVIEW: "secondary",
  APPROVED: "default",
  REJECTED: "destructive",
};

export function StatusBadge({ status }: { status: AdmissionStatus }) {
  return <Badge variant={VARIANT[status]}>{STATUS_LABEL[status]}</Badge>;
}

/** The six application steps (design §6). Step 5 uploads go through the dedicated route (KI-048). */
export const STEPS = ["Student & class", "Parents / guardians", "Contact & address", "Previous school", "Photo & documents", "Review & submit"] as const;
export const DOCUMENTS_STEP = 5;
export const REVIEW_STEP = 6;

export function StepNav({ id, current }: { id: string; current: number }) {
  return (
    <nav aria-label="Application steps">
      <ol className="flex gap-1 overflow-x-auto pb-1">
        {STEPS.map((label, i) => {
          const step = i + 1;
          const isCurrent = step === current;
          return (
            <li key={label} className="shrink-0">
              <Link
                href={`/erp/admissions/${id}/edit?step=${step}`}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm text-muted-foreground pointer-fine:min-h-9",
                  isCurrent && "border-primary font-medium text-foreground",
                )}
              >
                <span className={cn("flex size-5 items-center justify-center rounded-full border text-xs", step < current && "bg-primary text-primary-foreground")} aria-hidden="true">
                  {step < current ? <Check className="size-3" /> : step}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Definition list that collapses to one column on phones. */
export function Facts({ items }: { items: [string, string | null | undefined][] }) {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="break-words">{v && v.trim() !== "" ? v : "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

export const GENDER_LABEL: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };
export const RELATION_LABEL: Record<string, string> = { FATHER: "Father", MOTHER: "Mother", GUARDIAN: "Guardian", OTHER: "Other relative" };

export type Address = { line1?: string; line2?: string | null; city?: string; district?: string | null; state?: string; pinCode?: string; country?: string } | null;
export type PreviousSchool = { name?: string | null; board?: string | null; lastClass?: string | null; yearLeft?: string | null; tcNumber?: string | null } | null;

export function addressText(a: Address): string {
  if (!a) return "";
  return [a.line1, a.line2, a.city, a.district, a.state, a.pinCode, a.country].filter((x) => x && String(x).trim() !== "").join(", ");
}
