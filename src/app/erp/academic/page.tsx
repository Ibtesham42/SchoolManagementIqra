import { redirect } from "next/navigation";

/** "Classes" in the main menu lands on the sections of the current session. */
export default function AcademicIndexPage() {
  redirect("/erp/academic/sections");
}
