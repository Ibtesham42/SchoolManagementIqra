import { ValidationError } from "@/lib/errors";
import type { PermissionKey } from "@/lib/rbac/catalog";
import { detectFileType, EXTENSION, MIME, type DetectedType } from "./file-types";
import { DOCUMENT_MAX_BYTES, fileTooLargeMessage, LOGO_MAX_BYTES, PHOTO_STORED_MAX_BYTES } from "./upload-limits";

/**
 * Upload purposes. Each purpose fixes the allowed content types, the size limit, the visibility,
 * the permission required to upload, and the type of record that owns the file. PRIVATE purposes
 * also name the permission needed to read them. New purposes (student documents, staff
 * documents…) are added here with their own rules — never a generic "upload anything" path.
 */
interface BaseRule {
  allowed: DetectedType[];
  maxBytes: number;
  uploadPermission: PermissionKey;
  /** StoredFile.ownerType every file of this purpose must carry. */
  ownerType: string;
  description: string;
}
export type UploadRule =
  | (BaseRule & { visibility: "PUBLIC" })
  | (BaseRule & {
      visibility: "PRIVATE";
      /**
       * Needed in addition to the owning module's record-scope check; the file layer also verifies
       * that the file belongs to the exact owner the caller authorized (see canReadStoredFile).
       */
      readPermission: PermissionKey;
      /**
       * Phase 6B-M2: the permission a PORTAL account (parent / student, `AuthContext.portal` set) needs instead of
       * `readPermission`. Only for purposes families may download; the owning module's portal service must have run
       * `assertPortalStudent` for the owner's student first. Absent = never readable from the portal.
       */
      portalReadPermission?: PermissionKey;
    });

export const UPLOAD_RULES = {
  // Shown on public pages, the ERP and every PDF. PNG/JPEG only: the PDF engine can't embed WebP.
  // 800 KB keeps the multipart request under the default 1 MB server-action body limit
  // (upload-limits.ts; also checked in the browser before submitting).
  "school.logo": {
    allowed: ["image/png", "image/jpeg"],
    maxBytes: LOGO_MAX_BYTES,
    visibility: "PUBLIC",
    uploadPermission: "settings.manage",
    ownerType: "SchoolSetting",
    description: "School logo (PNG or JPEG, up to 800 KB)",
  },
  // Server-generated PDFs registered in GeneratedDocument (ID cards, certificates, receipts…).
  // Always PRIVATE: the public verification page shows registry facts, never the PDF.
  "document.pdf": {
    allowed: ["application/pdf"],
    maxBytes: 10 * 1024 * 1024,
    visibility: "PRIVATE",
    uploadPermission: "document.generate",
    readPermission: "document.generate",
    ownerType: "GeneratedDocument",
    description: "Generated document (PDF)",
  },
  // Admission / student documents (Phase 2B S4). Owner = the StudentDocument row, so ownership never
  // moves from application to student. Uploaded only through the dedicated route (KI-048).
  "student.document": {
    allowed: ["application/pdf", "image/jpeg", "image/png"],
    maxBytes: DOCUMENT_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "student.document.manage",
    readPermission: "student.document.read",
    ownerType: "StudentDocument",
    description: "Student document (PDF, JPEG or PNG, up to 10 MB)",
  },
  // Student photo AFTER server-side re-encoding (lib/images/photo.ts): always a 600×600 JPEG without
  // metadata. Readable with student.read (teachers of the student's section later see it on ID cards).
  "student.photo": {
    allowed: ["image/jpeg"],
    maxBytes: PHOTO_STORED_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "student.document.manage",
    readPermission: "student.read",
    ownerType: "StudentDocument",
    description: "Student photo (re-encoded JPEG)",
  },
  // Staff documents (Phase 3A M4b, H8): owner = the EmployeeDocument row. Reading needs the personal tier
  // (H6) — the HR service has already checked the record (ALL, or SELF on the own record). No identity-document
  // types exist (no Aadhaar/PAN copies, H5). Uploaded only through the dedicated route.
  "employee.document": {
    allowed: ["application/pdf", "image/jpeg", "image/png"],
    maxBytes: DOCUMENT_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "employee.document.manage",
    readPermission: "employee.personal.read",
    ownerType: "EmployeeDocument",
    description: "Staff document (PDF, JPEG or PNG, up to 10 MB)",
  },
  // Staff photo AFTER server-side re-encoding (600×600 JPEG, no metadata). Directory data (H6): employee.read.
  "employee.photo": {
    allowed: ["image/jpeg"],
    maxBytes: PHOTO_STORED_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "employee.document.manage",
    readPermission: "employee.read",
    ownerType: "EmployeeDocument",
    description: "Staff photo (re-encoded JPEG)",
  },
  // Homework attachment (Phase 4C, KI-094): one optional handout per Homework row (owner = the Homework id). Read with
  // academic.read AFTER the homework service's own section / subject check (every homework reader holds it).
  "homework.attachment": {
    allowed: ["application/pdf", "image/jpeg", "image/png"],
    maxBytes: DOCUMENT_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "homework.manage",
    readPermission: "academic.read",
    portalReadPermission: "homework.read",
    ownerType: "Homework",
    description: "Homework attachment (PDF, JPEG or PNG, up to 10 MB)",
  },
  // Notice attachment (Phase 6C-M1, P22): one optional PDF / image per Notice (owner = the Notice id), added while the
  // notice is a draft. Staff read it with notice.read and families with notice.read (portal), each only AFTER the
  // notices service decided the notice is theirs to read.
  "notice.attachment": {
    allowed: ["application/pdf", "image/jpeg", "image/png"],
    maxBytes: DOCUMENT_MAX_BYTES,
    visibility: "PRIVATE",
    uploadPermission: "notice.manage",
    readPermission: "notice.read",
    portalReadPermission: "notice.read",
    ownerType: "Notice",
    description: "Notice attachment (PDF, JPEG or PNG, up to 10 MB)",
  },
} as const satisfies Record<string, UploadRule>;

/** Purposes recorded for files that predate purposes (migration 20261109000000): Super Admin only. */
export const LEGACY_PURPOSE = "unclassified";

export function isUploadPurpose(value: string): value is UploadPurpose {
  return Object.hasOwn(UPLOAD_RULES, value);
}

export type UploadPurpose = keyof typeof UPLOAD_RULES;

export interface ValidatedUpload {
  type: DetectedType;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  originalName: string;
}

/** Display-only file name: no path parts, no control characters, bounded length. */
export function sanitizeFileName(name: string, fallbackExt: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").trim();
  const clean = base.slice(0, 200) || `file.${fallbackExt}`;
  return clean;
}

export function validateUpload(bytes: Uint8Array, declaredName: string, purpose: UploadPurpose): ValidatedUpload {
  const rule: UploadRule = UPLOAD_RULES[purpose];
  const field = [{ path: "file", message: "" }];
  if (bytes.length === 0) throw new ValidationError("The file is empty.", [{ ...field[0], message: "Choose a file." }]);
  if (bytes.length > rule.maxBytes) {
    const msg = fileTooLargeMessage(bytes.length, rule.maxBytes);
    throw new ValidationError(msg, [{ ...field[0], message: msg }]);
  }
  const type = detectFileType(bytes);
  if (!type || !rule.allowed.includes(type)) {
    const allowed = rule.allowed.map((t) => EXTENSION[t].toUpperCase()).join(", ");
    const msg = `This file type isn't accepted here. Allowed: ${allowed}.`;
    throw new ValidationError(msg, [{ ...field[0], message: msg }]);
  }
  return {
    type,
    mimeType: MIME[type],
    extension: EXTENSION[type],
    sizeBytes: bytes.length,
    originalName: sanitizeFileName(declaredName, EXTENSION[type]),
  };
}
