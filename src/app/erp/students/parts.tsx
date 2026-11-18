import { Badge } from "@/components/ui/badge";
import { STUDENT_STATUS_LABEL, type StudentStatus } from "@/modules/students/students.rules";

/** Server-rendered pieces shared by the student pages. The label carries the meaning (not colour alone). */
export function StudentStatusBadge({ status }: { status: StudentStatus }) {
  return <Badge variant={status === "ACTIVE" ? "default" : "outline"}>{STUDENT_STATUS_LABEL[status]}</Badge>;
}
