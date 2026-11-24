import type { PermissionKey, Scope } from "@/lib/rbac/catalog";

export type NavIcon =
  | "dashboard"
  | "admissions"
  | "students"
  | "rollNumbers"
  | "academic"
  | "users"
  | "roles"
  | "settings"
  | "account"
  | "staff"
  | "leave"
  | "staffAttendance"
  | "payroll"
  | "fees"
  | "notices";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Shown when the user holds ANY of these permissions. Empty = every signed-in user. */
  anyOf: PermissionKey[];
  /**
   * Optional: shown only when the user's WIDEST scope for `key` is one of `scopes`. Used where a page can
   * serve only some scopes (e.g. the student directory: ALL / ASSIGNED; Parent and Student roles hold
   * student.read at CHILDREN / SELF for the future portal, which has no screen yet — no dead menu links).
   */
  scope?: { key: PermissionKey; scopes: Scope[] };
}

/** Modules appear here only once they are implemented (no placeholder links). */
export const NAV_ITEMS: NavItem[] = [
  { href: "/erp", label: "Dashboard", icon: "dashboard", anyOf: [] },
  {
    href: "/erp/admissions",
    label: "Admissions",
    icon: "admissions",
    anyOf: ["admission.read"],
  },
  {
    href: "/erp/students",
    label: "Students",
    icon: "students",
    anyOf: ["student.read"],
    scope: { key: "student.read", scopes: ["ALL", "ASSIGNED"] },
  },
  {
    href: "/erp/students/registration",
    label: "Roll numbers",
    icon: "rollNumbers",
    anyOf: ["rollnumber.generate", "rollnumber.finalize", "rollnumber.correct"],
  },
  // Staff directory: ALL readers only (SELF "my profile" arrives with M3, on the account page).
  {
    href: "/erp/hr",
    label: "Staff",
    icon: "staff",
    anyOf: ["employee.read"],
    scope: { key: "employee.read", scopes: ["ALL"] },
  },
  {
    href: "/erp/leave",
    label: "Leave",
    icon: "leave",
    anyOf: ["leave.request", "leave.approve"],
  },
  // Phase 3B M4/M5: own attendance (SELF, L9), the register (ALL), marking (HR) and the payroll summary (preparers).
  {
    href: "/erp/staff-attendance",
    label: "Staff attendance",
    icon: "staffAttendance",
    anyOf: ["attendance.employee.read", "attendance.employee.mark", "payroll.prepare"],
  },
  // Phase 3C: salary components and structures (more payroll screens follow).
  {
    href: "/erp/payroll",
    label: "Payroll",
    icon: "payroll",
    anyOf: ["payroll.read", "salary.structure.manage"],
  },
  // Phase 3C-M5 (P12): every staff member's own slips (salary.self.read SELF).
  {
    href: "/erp/payroll/my-slips",
    label: "My salary slips",
    icon: "payroll",
    anyOf: ["salary.self.read"],
  },
  // Phase 5A-M2: fee setup. fee.read at ALL only — Parent (CHILDREN) and Student (SELF) wait for the portal (FC17).
  {
    href: "/erp/fees",
    label: "Fees",
    icon: "fees",
    anyOf: ["fee.read", "fee.structure.manage"],
    scope: { key: "fee.read", scopes: ["ALL"] },
  },
  {
    href: "/erp/academic",
    label: "Classes",
    icon: "academic",
    anyOf: ["academic.read"],
  }, // every academic screen reads first; manage alone shows nothing
  // Phase 6C-M1 (P22): school notices — every staff role reads; notice.manage holders also write.
  { href: "/erp/notices", label: "Notices", icon: "notices", anyOf: ["notice.read", "notice.manage"] },
  { href: "/erp/users", label: "Users", icon: "users", anyOf: ["user.read"] },
  { href: "/erp/roles", label: "Roles", icon: "roles", anyOf: ["role.manage"] },
  {
    href: "/erp/settings",
    label: "Settings",
    icon: "settings",
    anyOf: ["settings.read"],
  },
  { href: "/erp/account", label: "My account", icon: "account", anyOf: [] },
];

/**
 * Items visible to a user, given a permission check and the user's widest scope per permission (the layout
 * passes `hasPermission(ctx, …)` and `scopeFor(ctx, …)`). Cosmetic only — every page and service authorizes.
 */
export function visibleNavItems(
  can: (key: PermissionKey) => boolean,
  scopeOf: (key: PermissionKey) => Scope | null,
  items: NavItem[] = NAV_ITEMS,
): NavItem[] {
  return items.filter((i) => {
    if (i.anyOf.length > 0 && !i.anyOf.some(can)) return false;
    if (i.scope) {
      const scope = can(i.scope.key) ? scopeOf(i.scope.key) : null;
      if (!scope || !i.scope.scopes.includes(scope)) return false;
    }
    return true;
  });
}

/**
 * The one item to highlight for a path: the LONGEST href that equals the path or is a parent segment of it
 * ("/erp/students/registration/x" → "Roll numbers", not also "Students"). "/erp" only matches itself.
 */
export function activeNavHref(
  pathname: string,
  items: NavItem[],
): string | null {
  let best: string | null = null;
  for (const { href } of items) {
    const match =
      href === "/erp"
        ? pathname === "/erp"
        : pathname === href || pathname.startsWith(`${href}/`);
    if (match && (best === null || href.length > best.length)) best = href;
  }
  return best;
}
