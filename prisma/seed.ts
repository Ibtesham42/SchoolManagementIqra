/**
 * Idempotent seed: permissions, roles, default grants, a placeholder SchoolSetting
 * and (optionally) the first Super Admin.
 *
 * - Never overwrites grants that Super Admin edited: grants are only ADDED for roles
 *   created by this run (or the system SUPER_ADMIN role, which always holds everything).
 * - School data is an obvious placeholder ("Demo Public School") to be replaced in Settings.
 * - Super Admin credentials come from SEED_SUPERADMIN_USERNAME / SEED_SUPERADMIN_PASSWORD
 *   and the account is forced to change its password on first login.
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ALL_PERMISSION_KEYS, PERMISSIONS, ROLES, moduleOf, normalizeGrant } from "../src/lib/rbac/catalog";
import { hashPassword, passwordProblem } from "../src/lib/auth/password";

async function main() {
  // 1. Permissions
  for (const key of ALL_PERMISSION_KEYS) {
    await prisma.permission.upsert({
      where: { key },
      create: { key, module: moduleOf(key), description: PERMISSIONS[key] },
      update: { module: moduleOf(key), description: PERMISSIONS[key] },
    });
  }
  const permissionIds = new Map((await prisma.permission.findMany({ select: { id: true, key: true } })).map((p) => [p.key, p.id]));

  // 2. Roles + default grants
  for (const def of ROLES) {
    const existing = await prisma.role.findUnique({ where: { key: def.key } });
    const role =
      existing ??
      (await prisma.role.create({
        data: { key: def.key, name: def.name, description: def.description, isSystem: def.isSystem ?? false },
      }));
    if (existing && !def.isSystem) continue; // keep admin-edited grants

    for (const grant of def.grants) {
      const { key, scope } = normalizeGrant(grant);
      const permissionId = permissionIds.get(key);
      if (!permissionId) throw new Error(`Unknown permission in catalog: ${key}`);
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        create: { roleId: role.id, permissionId, scope },
        update: def.isSystem ? { scope } : {},
      });
    }
  }

  // 3. Placeholder school settings (only if absent)
  await prisma.schoolSetting.upsert({
    where: { id: "default" },
    create: {
      name: "Demo Public School",
      shortCode: "DEMO",
      phones: [],
      timezone: "Asia/Kolkata",
      idFormats: {
        studentId: "{CODE}-{YYYY}-{SEQ:4}",
        admissionNo: "ADM-{YYYY}-{SEQ:4}",
        employeeCode: "EMP-{SEQ:4}",
        receiptNo: "RCPT-{SESSION}-{SEQ:5}",
      },
      rollNumberRules: { sort: "fullName", tieBreak: ["dob", "studentCode"], lateAdmission: "append" },
    },
    update: {},
  });

  // 4. First Super Admin (optional)
  const username = process.env.SEED_SUPERADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (username && password) {
    const problem = passwordProblem(password, username);
    if (problem) throw new Error(`SEED_SUPERADMIN_PASSWORD rejected: ${problem}`);
    const exists = await prisma.user.findUnique({ where: { username } });
    if (!exists) {
      const superAdmin = await prisma.role.findUniqueOrThrow({ where: { key: "SUPER_ADMIN" } });
      await prisma.user.create({
        data: {
          username,
          displayName: "Super Admin",
          passwordHash: await hashPassword(password),
          mustChangePassword: true,
          roles: { create: { roleId: superAdmin.id } },
        },
      });
      console.log(`Created Super Admin "${username}" (password change required on first login).`);
    } else {
      console.log(`Super Admin "${username}" already exists — unchanged.`);
    }
  } else {
    console.log("SEED_SUPERADMIN_USERNAME/PASSWORD not set — skipped creating Super Admin.");
  }

  const [p, r, rp] = await Promise.all([prisma.permission.count(), prisma.role.count(), prisma.rolePermission.count()]);
  console.log(`Seed complete: ${p} permissions, ${r} roles, ${rp} role grants.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
