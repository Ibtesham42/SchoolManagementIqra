import { redirect } from "next/navigation";

/** The HR dashboard arrives in M5; until then the staff area opens on the directory. */
export default function HrPage() {
  redirect("/erp/hr/employees");
}
