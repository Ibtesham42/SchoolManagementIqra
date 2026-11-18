import { Badge } from "@/components/ui/badge";
import { EMPLOYMENT_STATUS_LABEL, type EmploymentStatus } from "@/modules/hr/hr.rules";

/** Employment status as text (never colour alone). */
export function StatusBadge({ status }: { status: EmploymentStatus }) {
  return <Badge variant={status === "ACTIVE" ? "default" : status === "ON_LEAVE" ? "outline" : "secondary"}>{EMPLOYMENT_STATUS_LABEL[status]}</Badge>;
}
