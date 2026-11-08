import type { PermissionKey } from "@/lib/rbac/catalog";

export type NavIcon = "dashboard" | "users" | "roles" | "account";

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /** Shown when the user holds ANY of these permissions. Empty = every signed-in user. */
  anyOf: PermissionKey[];
}

/** Modules appear here only once they are implemented (no placeholder links). */
export const NAV_ITEMS: NavItem[] = [
  { href: "/erp", label: "Dashboard", icon: "dashboard", anyOf: [] },
  { href: "/erp/users", label: "Users", icon: "users", anyOf: ["user.read"] },
  { href: "/erp/roles", label: "Roles", icon: "roles", anyOf: ["role.manage"] },
  { href: "/erp/account", label: "My account", icon: "account", anyOf: [] },
];
