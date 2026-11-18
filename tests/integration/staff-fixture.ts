/**
 * Integration fixture (not a *.test.ts file): since Phase 3A M3b (H4) a class teacher's account must be linked
 * to an ACTIVE, TEACHING employee. Suites that assign class teachers call `linkTeachingEmployee` for those users
 * and `removeStaffFixtures` FIRST in afterAll (user.employee_id → employee is RESTRICT: unlink, then delete).
 * Synthetic data only; direct fixture writes (the HR services are tested in hr-*.test.ts).
 */
type Prisma = (typeof import("@/lib/db"))["prisma"];

export async function linkTeachingEmployee(
  prisma: Prisma,
  tag: string,
  userId: string,
  opts: { staffType?: "TEACHING" | "NON_TEACHING"; status?: "ACTIVE" | "RESIGNED" } = {},
): Promise<string> {
  const code = `FX${tag}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
  const staffType = opts.staffType ?? "TEACHING";
  const department = await prisma.department.upsert({ where: { code }, update: {}, create: { code, name: `Fixture ${code}`, nameKey: `fixture ${code.toLowerCase()}` }, select: { id: true } });
  const desigCode = `${code}-${staffType === "TEACHING" ? "T" : "N"}`;
  const designation = await prisma.designation.upsert({
    where: { code: desigCode },
    update: {},
    create: { code: desigCode, name: `Fixture ${desigCode}`, nameKey: `fixture ${desigCode.toLowerCase()}`, staffType },
    select: { id: true },
  });
  const leaving = opts.status === "RESIGNED";
  const employee = await prisma.employee.create({
    data: {
      employeeCode: `FIX-${code}-${userId.slice(-8)}`,
      staffType,
      appointmentType: "PERMANENT",
      employmentStatus: opts.status ?? "ACTIVE",
      firstName: "Fixture",
      fullName: "Fixture Teacher",
      fullNameNormalized: "fixture teacher",
      dob: new Date("1985-01-01T00:00:00.000Z"),
      gender: "OTHER",
      personalPhone: "9000000000",
      departmentId: department.id,
      designationId: designation.id,
      joiningDate: new Date("2020-06-01T00:00:00.000Z"),
      leavingDate: leaving ? new Date("2026-01-01T00:00:00.000Z") : null,
      leavingReason: leaving ? "Fixture" : null,
    },
    select: { id: true },
  });
  await prisma.user.update({ where: { id: userId }, data: { employeeId: employee.id } });
  return employee.id;
}

export async function removeStaffFixtures(prisma: Prisma, tag: string): Promise<void> {
  const code = `FX${tag}`.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 18);
  const employees = await prisma.employee.findMany({ where: { employeeCode: { startsWith: `FIX-${code}-` } }, select: { id: true } });
  const ids = employees.map((e) => e.id);
  await prisma.user.updateMany({ where: { employeeId: { in: ids } }, data: { employeeId: null } });
  await prisma.employee.deleteMany({ where: { id: { in: ids } } });
  await prisma.designation.deleteMany({ where: { code: { startsWith: `${code}-` } } });
  await prisma.department.deleteMany({ where: { code } });
}
