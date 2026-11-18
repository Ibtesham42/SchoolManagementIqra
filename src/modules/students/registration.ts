import type { Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Permanent registration of an approved applicant (design §2.3, owner decision D1). Runs INSIDE the
 * approval transaction and is called ONLY by admissions.approveApplication, which has already authorized
 * the approver, locked the application, session and section, checked capacity and duplicates, validated
 * the guardian links and taken both permanent IDs. Nothing here does I/O outside the database.
 *
 * Audit entries carry ids and relationships only — never names, phone numbers or addresses.
 */
export interface RegistrationApplicant {
  id: string;
  firstName: string;
  middleName: string | null;
  lastName: string | null;
  fullName: string;
  fullNameNormalized: string;
  dob: Date;
  gender: "MALE" | "FEMALE" | "OTHER";
  phone: string | null;
  email: string | null;
  address: Prisma.JsonValue | null;
  previousSchool: Prisma.JsonValue | null;
}

export interface RegistrationGuardian {
  id: string;
  relation: "FATHER" | "MOTHER" | "GUARDIAN" | "OTHER";
  name: string;
  phone: string;
  altPhone: string | null;
  email: string | null;
  occupation: string | null;
  isPrimary: boolean;
  isEmergencyContact: boolean;
}

export interface RegistrationInput {
  applicant: RegistrationApplicant;
  guardians: RegistrationGuardian[];
  /** applicant-guardian id → existing Guardian id (explicit reviewer choice) or null (create new). */
  guardianLinks: Map<string, string | null>;
  academicSessionId: string;
  sectionId: string;
  admissionDate: Date;
  studentCode: string;
  admissionNo: string;
}

const json = (v: Prisma.JsonValue | null) => (v === null ? undefined : (v as Prisma.InputJsonValue));

export async function registerStudent(tx: Tx, actor: AuditActor, input: RegistrationInput): Promise<{ studentId: string; enrollmentId: string }> {
  const a = input.applicant;
  const student = await tx.student.create({
    data: {
      studentCode: input.studentCode,
      admissionNo: input.admissionNo,
      firstName: a.firstName,
      middleName: a.middleName,
      lastName: a.lastName,
      fullName: a.fullName,
      fullNameNormalized: a.fullNameNormalized,
      dob: a.dob,
      gender: a.gender,
      phone: a.phone,
      email: a.email,
      address: json(a.address),
      previousSchool: json(a.previousSchool),
      admissionDate: input.admissionDate,
      admittedSessionId: input.academicSessionId,
    },
    select: { id: true },
  });
  await audit(tx, actor, {
    action: "student.create",
    entityType: "Student",
    entityId: student.id,
    after: { studentCode: input.studentCode, admissionNo: input.admissionNo, applicationId: a.id, academicSessionId: input.academicSessionId, status: "ACTIVE" },
  });

  for (const g of input.guardians) {
    let guardianId = input.guardianLinks.get(g.id) ?? null;
    if (guardianId) {
      await audit(tx, actor, { action: "guardian.link", entityType: "Guardian", entityId: guardianId, after: { studentId: student.id, relation: g.relation, applicationGuardianId: g.id } });
    } else {
      const created = await tx.guardian.create({
        data: { name: g.name, phone: g.phone, altPhone: g.altPhone, email: g.email, occupation: g.occupation },
        select: { id: true },
      });
      guardianId = created.id;
      await audit(tx, actor, { action: "guardian.create", entityType: "Guardian", entityId: guardianId, after: { studentId: student.id, relation: g.relation } });
    }
    await tx.studentGuardian.create({
      data: { studentId: student.id, guardianId, relation: g.relation, isPrimary: g.isPrimary, isEmergencyContact: g.isEmergencyContact },
    });
  }

  const enrollment = await tx.studentEnrollment.create({
    data: { studentId: student.id, academicSessionId: input.academicSessionId, sectionId: input.sectionId, status: "ACTIVE", enrolledOn: input.admissionDate },
    select: { id: true },
  });
  await audit(tx, actor, {
    action: "enrollment.create",
    entityType: "StudentEnrollment",
    entityId: enrollment.id,
    after: { studentId: student.id, academicSessionId: input.academicSessionId, sectionId: input.sectionId, status: "ACTIVE" },
  });

  // The application's documents now also belong to the student (same rows; their files stay owned by them).
  await tx.studentDocument.updateMany({ where: { applicationId: a.id }, data: { studentId: student.id } });

  return { studentId: student.id, enrollmentId: enrollment.id };
}
