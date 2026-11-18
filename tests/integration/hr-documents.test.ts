import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled } from "../test-scope";

/**
 * Phase 3A M4b — staff documents and photo against real Postgres (Test branch only, behind the S-05 guard) with the
 * in-memory storage driver. Synthetic data only; removed in afterAll except audit rows and shared counter rows.
 */
const enabled = integrationEnabled();

const load = async () => ({
  ...(await import("@/lib/db")),
  ...(await import("@/lib/auth/session")),
  ...(await import("@/lib/errors")),
  ...(await import("@/lib/storage/driver")),
  ...(await import("@/modules/identity/super-admin-guard")),
  ...(await import("@/modules/hr/master-data.service")),
  ...(await import("@/modules/hr/employees.service")),
  ...(await import("@/modules/hr/staff-accounts.service")),
  ...(await import("@/modules/hr/employee-documents.service")),
});
const m = enabled
  ? await load()
  : (null as unknown as Awaited<ReturnType<typeof load>>);

describe.skipIf(!enabled)("HR staff documents (integration)", () => {
  const run = `hx${Date.now().toString(36)}`;
  const tag = Math.random().toString(36).slice(2, 6).toUpperCase();
  type Ctx = NonNullable<Awaited<ReturnType<typeof m.validateSessionToken>>>;
  let root: Ctx, hr: Ctx, librarian: Ctx;
  let empA: string, empB: string, staffUserId: string;
  const employeeIds: string[] = [];
  let driver: InstanceType<typeof m.MemoryDriver>;
  const PDF = new Uint8Array(Buffer.from("%PDF-1.7\nsynthetic\n%%EOF"));
  let PNG: Uint8Array;

  async function ctxFor(userId: string): Promise<Ctx> {
    const { token } = await m.createSession(userId, { long: false });
    return (await m.validateSessionToken(token))!;
  }
  async function user(suffix: string, roleKey: string) {
    const role = await m.prisma.role.findUniqueOrThrow({
      where: { key: roleKey },
    });
    return m.prisma.$transaction(async (tx) => {
      if (roleKey === "SUPER_ADMIN") await m.lockSuperAdminGuard(tx);
      return tx.user.create({
        data: {
          username: `${run}-${suffix}`,
          displayName: `Synthetic ${suffix}`,
          passwordHash: "x",
          roles: { create: { roleId: role.id } },
        },
      });
    });
  }

  beforeAll(async () => {
    await (await import("./catalog-setup")).ensureCatalog();
    driver = new m.MemoryDriver();
    m.setStorageDriverForTests(driver);
    const sharp = (await import("sharp")).default;
    PNG = new Uint8Array(
      await sharp({
        create: { width: 40, height: 40, channels: 3, background: "#336699" },
      })
        .png()
        .toBuffer(),
    );
    const [r, h, lib, staff] = await Promise.all([
      user("root", "SUPER_ADMIN"),
      user("hr", "HR_MANAGER"),
      user("lib", "LIBRARIAN"),
      user("staff", "ACCOUNTANT"),
    ]);
    [root, hr, librarian] = await Promise.all(
      [r, h, lib].map((u) => ctxFor(u.id)),
    );
    staffUserId = staff.id;
    const dept = (await m.createDepartment(hr, {
      code: `${tag}-D`,
      name: `${run} Dept`,
    }))!.id;
    const desig = (await m.createDesignation(hr, {
      code: `${tag}-C`,
      name: `${run} Clerk`,
      staffType: "NON_TEACHING",
    }))!.id;
    for (let i = 0; i < 2; i++) {
      const { id } = await m.registerEmployee(hr, {
        firstName: "Synthetic",
        middleName: null,
        lastName: `Docs ${run} ${i}`,
        dob: "1984-04-04",
        gender: "OTHER",
        personalPhone: `95678${String(10000 + i).slice(1)}`,
        workPhone: null,
        personalEmail: null,
        workEmail: null,
        address: null,
        emergencyContact: null,
        departmentId: dept,
        designationId: desig,
        appointmentType: "PERMANENT",
        joiningDate: "2025-01-01",
        confirmationDate: null,
        reportsToId: null,
      });
      employeeIds.push(id);
    }
    [empA, empB] = employeeIds;
  }, 180_000);

  afterAll(async () => {
    const { prisma } = m;
    if (!prisma) return;
    m.setStorageDriverForTests(undefined);
    const docs = await prisma.employeeDocument.findMany({
      where: { employeeId: { in: employeeIds } },
      select: { fileId: true },
    });
    await prisma.user.updateMany({
      where: { employeeId: { in: employeeIds } },
      data: { employeeId: null },
    });
    await prisma.employeeDocument.deleteMany({
      where: { employeeId: { in: employeeIds } },
    });
    await prisma.storedFile.deleteMany({
      where: { id: { in: docs.map((d) => d.fileId) } },
    });
    await prisma.employeeServiceEvent.deleteMany({
      where: { employeeId: { in: employeeIds } },
    });
    await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
    await prisma.designation.deleteMany({
      where: { code: { startsWith: `${tag}-` } },
    });
    await prisma.department.deleteMany({
      where: { code: { startsWith: `${tag}-` } },
    });
    await prisma.$transaction(async (tx) => {
      await m.lockSuperAdminGuard(tx);
      await tx.user.deleteMany({ where: { username: { startsWith: run } } });
    });
    await prisma.$disconnect();
  }, 120_000);

  it("upload: encrypted at rest, owner-bound to its EmployeeDocument row, audited without contents", async () => {
    const doc = await m.addEmployeeDocument(
      hr,
      empA,
      { type: "RESUME", label: null },
      { bytes: PDF, fileName: "cv.pdf" },
    );
    const row = await m.prisma.employeeDocument.findUniqueOrThrow({
      where: { id: doc.id },
      select: {
        fileId: true,
        file: {
          select: {
            purpose: true,
            ownerType: true,
            ownerId: true,
            encrypted: true,
            storageKey: true,
            visibility: true,
          },
        },
      },
    });
    expect(row.file).toMatchObject({
      purpose: "employee.document",
      ownerType: "EmployeeDocument",
      ownerId: doc.id,
      encrypted: true,
      visibility: "PRIVATE",
    });
    expect(
      Buffer.from(await driver.get(row.file.storageKey)).includes(
        Buffer.from("synthetic"),
      ),
    ).toBe(false); // ciphertext only
    const read = await m.readEmployeeDocument(hr, empA, doc.id);
    expect(Buffer.from(read.bytes).equals(Buffer.from(PDF))).toBe(true);
    const log = await m.prisma.auditLog.findFirstOrThrow({
      where: { action: "employee_document.upload", entityId: doc.id },
    });
    expect(JSON.stringify(log.after)).not.toMatch(/synthetic|cv\.pdf/);
  });

  it("photo: re-encoded JPEG, one current photo (the old one retired), readable by directory readers", async () => {
    const p1 = await m.addEmployeeDocument(
      hr,
      empA,
      { type: "PHOTO", label: null },
      { bytes: PNG, fileName: "me.png" },
    );
    const p2 = await m.addEmployeeDocument(
      hr,
      empA,
      { type: "PHOTO", label: null },
      { bytes: PNG, fileName: "me2.png" },
    );
    const photos = await m.prisma.employeeDocument.findMany({
      where: { employeeId: empA, type: "PHOTO" },
      select: {
        id: true,
        deletedAt: true,
        file: { select: { deletedAt: true, mimeType: true } },
      },
    });
    expect(photos.find((p) => p.id === p1.id)?.deletedAt).not.toBeNull();
    expect(photos.find((p) => p.id === p1.id)?.file.deletedAt).not.toBeNull(); // retired → purged by S-15 after 30 days
    expect(photos.find((p) => p.id === p2.id)).toMatchObject({
      deletedAt: null,
      file: { mimeType: "image/jpeg" },
    });
    expect((await m.readEmployeePhoto(librarian, empA)).mimeType).toBe(
      "image/jpeg",
    );
    await expect(
      m.prisma.employeeDocument.update({
        where: { id: p1.id },
        data: { deletedAt: null },
      }),
    ).rejects.toThrow(); // one current photo (partial unique index)
  });

  it("tiers and ownership: Librarian sees no documents; another employee's id never matches; SELF sees own", async () => {
    const doc = await m.addEmployeeDocument(
      hr,
      empA,
      { type: "OTHER", label: "Synthetic certificate" },
      { bytes: PDF, fileName: "c.pdf" },
    );
    expect(await m.listEmployeeDocuments(librarian, empA)).toBeNull();
    await expect(
      m.readEmployeeDocument(librarian, empA, doc.id),
    ).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(
      m.readEmployeeDocument(hr, empB, doc.id),
    ).rejects.toBeInstanceOf(m.NotFoundError); // wrong owner
    await m.linkStaffAccount(root, { employeeId: empA, userId: staffUserId });
    const me = await ctxFor(staffUserId);
    expect((await m.listEmployeeDocuments(me, empA))?.length).toBeGreaterThan(
      0,
    );
    expect(
      Buffer.from(
        (await m.readEmployeeDocument(me, empA, doc.id)).bytes,
      ).equals(Buffer.from(PDF)),
    ).toBe(true);
    await expect(m.listEmployeeDocuments(me, empB)).rejects.toBeInstanceOf(
      m.NotFoundError,
    );
    await m.unlinkStaffAccount(root, empA);
  });

  it("verify and remove (retires the file); readers and SELF can't manage", async () => {
    const doc = await m.addEmployeeDocument(
      hr,
      empB,
      { type: "EXPERIENCE_LETTER", label: null },
      { bytes: PDF, fileName: "x.pdf" },
    );
    await m.verifyEmployeeDocument(hr, empB, doc.id);
    await expect(
      m.verifyEmployeeDocument(hr, empB, doc.id),
    ).rejects.toBeInstanceOf(m.ConflictError);
    await expect(
      m.removeEmployeeDocument(librarian, empB, doc.id),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
    await m.removeEmployeeDocument(hr, empB, doc.id);
    const row = await m.prisma.employeeDocument.findUniqueOrThrow({
      where: { id: doc.id },
      select: {
        deletedAt: true,
        verifiedById: true,
        file: { select: { deletedAt: true } },
      },
    });
    expect(row.deletedAt).not.toBeNull();
    expect(row.file.deletedAt).not.toBeNull();
    expect(row.verifiedById).toBe(hr.userId);
    await expect(
      m.readEmployeeDocument(hr, empB, doc.id),
    ).rejects.toBeInstanceOf(m.NotFoundError);
    await expect(
      m.addEmployeeDocument(
        librarian,
        empB,
        { type: "RESUME", label: null },
        { bytes: PDF, fileName: "x.pdf" },
      ),
    ).rejects.toBeInstanceOf(m.ForbiddenError);
  });
});
