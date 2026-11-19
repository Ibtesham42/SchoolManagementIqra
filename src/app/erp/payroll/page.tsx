import { redirect } from "next/navigation";

/** "Payroll" in the main menu lands on salary components (more payroll screens arrive with 3C-M3 … M6). */
export default function PayrollIndexPage() {
  redirect("/erp/payroll/components");
}
