import { z } from "zod";
import { ALL_PERMISSION_KEYS, type PermissionKey } from "@/lib/rbac/catalog";

export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,49}$/;

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_PATTERN, "3–50 characters: letters, digits, dot, dash or underscore.");
const displayName = z.string().trim().min(2, "Enter a name.").max(120);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .transform((v) => (v === "" ? null : v))
  .pipe(z.email("Enter a valid email address.").nullable());
const roleKeys = z.array(z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/)).max(13).default([]);
const id = z.string().min(1).max(64);

export const listUsersSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    status: z.enum(["all", "active", "inactive"]).default("all"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(5).max(100).default(25),
  })
  .strict();

export const createUserSchema = z.object({ username, displayName, email, roleKeys }).strict();
export const updateUserSchema = z.object({ id, displayName, email, roleKeys }).strict();
export const userIdSchema = z.object({ id }).strict();

export const createRoleSchema = z
  .object({
    key: z.string().trim().toUpperCase(),
    name: z.string().trim().min(2).max(60),
    description: z.string().trim().max(300).optional().default(""),
  })
  .strict();

export const updateRoleSchema = z
  .object({ id, name: z.string().trim().min(2).max(60), description: z.string().trim().max(300).optional().default("") })
  .strict();

const permissionKey = z.enum(ALL_PERMISSION_KEYS as [PermissionKey, ...PermissionKey[]]);
export const setRolePermissionsSchema = z
  .object({
    id,
    grants: z
      .array(z.object({ key: permissionKey, scope: z.enum(["ALL", "ASSIGNED", "SELF", "CHILDREN"]) }).strict())
      .max(ALL_PERMISSION_KEYS.length)
      .refine((g) => new Set(g.map((x) => x.key)).size === g.length, "Each permission may appear only once."),
  })
  .strict();

export const passwordResetRequestSchema = z.object({ identifier: z.string().trim().toLowerCase().min(1).max(254) }).strict();
export const passwordResetCompleteSchema = z
  .object({
    token: z.string().min(20).max(100),
    newPassword: z.string().min(1).max(128),
    confirmPassword: z.string().min(1).max(128),
  })
  .strict();
