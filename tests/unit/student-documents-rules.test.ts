import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/errors";
import { buildPermissionMap, type AuthContext } from "@/lib/rbac/authorize";
import { ROLES, normalizeGrant } from "@/lib/rbac/catalog";
import { DOCUMENT_MAX_BYTES, PHOTO_STORED_MAX_BYTES, SERVER_ACTION_BODY_LIMIT, UPLOAD_REQUEST_MAX_BYTES } from "@/lib/storage/upload-limits";
import { UPLOAD_RULES, validateUpload } from "@/lib/storage/upload-rules";
import { canReadStoredFile } from "@/modules/files/files.service";
import { documentUploadFieldsSchema } from "@/modules/admissions/documents.schemas";

/** Phase 2B S4 — student document upload purposes, owner-bound read access and the upload form fields. */
const PDF = Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n%%EOF");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const HTML = Buffer.from("<!doctype html><script>alert(1)</script>");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe("upload purposes", () => {
  it("both are PRIVATE, owned by a StudentDocument, uploaded only with student.document.manage", () => {
    for (const p of ["student.document", "student.photo"] as const) {
      const r = UPLOAD_RULES[p];
      expect([r.visibility, r.ownerType, r.uploadPermission]).toEqual(["PRIVATE", "StudentDocument", "student.document.manage"]);
    }
    expect(UPLOAD_RULES["student.document"].readPermission).toBe("student.document.read");
    expect(UPLOAD_RULES["student.photo"].readPermission).toBe("student.read");
  });
  it("limits: 10 MB per document (route body ≤ 10 MB + 64 KB); stored photo ≤ 2 MB; above the 1 MB server-action limit (KI-048)", () => {
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(UPLOAD_REQUEST_MAX_BYTES).toBe(10 * 1024 * 1024 + 64 * 1024);
    expect(PHOTO_STORED_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(DOCUMENT_MAX_BYTES).toBeGreaterThan(SERVER_ACTION_BODY_LIMIT);
  });
  it.each([["PDF", PDF, "application/pdf"], ["PNG", PNG, "image/png"], ["JPEG", JPEG, "image/jpeg"]])("documents accept %s by content", (_l, bytes, mime) => {
    expect(validateUpload(bytes, "anything.bin", "student.document").mimeType).toBe(mime);
  });
  it.each([["DOCX", DOCX], ["SVG", SVG], ["HTML", HTML], ["Windows executable", EXE], ["empty", Buffer.alloc(0)]])("documents refuse %s whatever its name says", (_l, bytes) => {
    expect(() => validateUpload(bytes, "birth-certificate.pdf", "student.document")).toThrow(ValidationError);
  });
  it("a renamed file is judged by its content: PDF bytes named .jpg are a PDF; HTML named .pdf is refused", () => {
    expect(validateUpload(PDF, "photo.jpg", "student.document").mimeType).toBe("application/pdf");
    expect(() => validateUpload(HTML, "report.pdf", "student.document")).toThrow(ValidationError);
  });
  it("oversized documents are refused with the limit in the message", () => {
    expect(() => validateUpload(Buffer.concat([PDF, Buffer.alloc(DOCUMENT_MAX_BYTES)]), "big.pdf", "student.document")).toThrow(/limit is 10\.0 MB/);
  });
  it("stored photos are JPEG only (the re-encoded output) — PNG and PDF refused", () => {
    expect(validateUpload(JPEG, "photo.jpg", "student.photo").mimeType).toBe("image/jpeg");
    expect(() => validateUpload(PNG, "photo.png", "student.photo")).toThrow(ValidationError);
    expect(() => validateUpload(PDF, "photo.pdf", "student.photo")).toThrow(ValidationError);
  });
  it("display names are sanitised (no paths, no control characters)", () => {
    expect(validateUpload(PDF, "..\\..\\C:\\secret\\tc\u0000.pdf", "student.document").originalName).toBe("tc.pdf");
  });
});

function ctxFor(roleKey: string, over: Partial<AuthContext> = {}): AuthContext {
  const role = ROLES.find((r) => r.key === roleKey)!;
  const rows = role.grants.map((g) => ({ roleKey, isSystem: !!role.isSystem, permissionKey: normalizeGrant(g).key, scope: normalizeGrant(g).scope }));
  return { userId: `u-${roleKey}`, username: "u", displayName: "U", roleKeys: [roleKey], sessionId: "s", isSuperAdmin: roleKey === "SUPER_ADMIN", permissions: buildPermissionMap(rows), ...over };
}

describe("owner-bound read access (canReadStoredFile)", () => {
  const docFile = { visibility: "PRIVATE" as const, purpose: "student.document", ownerType: "StudentDocument", ownerId: "doc1" };
  const photoFile = { ...docFile, purpose: "student.photo" };
  const access = (purpose: "student.document" | "student.photo", id = "doc1") => ({ purpose, owner: { type: "StudentDocument", id } });

  it("readers of documents: School Admin, Principal, Vice Principal, Admission Officer — only for the exact document", () => {
    for (const role of ["SCHOOL_ADMIN", "PRINCIPAL", "VICE_PRINCIPAL", "ADMISSION_OFFICER"]) {
      expect(canReadStoredFile(ctxFor(role), docFile, access("student.document")), role).toBe(true);
      expect(canReadStoredFile(ctxFor(role), docFile, access("student.document", "doc2")), `${role} other doc`).toBe(false);
      expect(canReadStoredFile(ctxFor(role), docFile, access("student.photo")), `${role} wrong purpose`).toBe(false);
    }
  });
  it("Teacher, Class Teacher, Accountant, Parent and Student can't read documents", () => {
    for (const role of ["TEACHER", "CLASS_TEACHER", "ACCOUNTANT", "PARENT", "STUDENT", "LIBRARIAN"]) {
      expect(canReadStoredFile(ctxFor(role), docFile, access("student.document")), role).toBe(false);
    }
  });
  it("photos follow student.read (once the module has checked the record scope)", () => {
    expect(canReadStoredFile(ctxFor("ADMISSION_OFFICER"), photoFile, access("student.photo"))).toBe(true);
    expect(canReadStoredFile(ctxFor("PARENT"), photoFile, access("student.photo"))).toBe(true); // CHILDREN scope — the module checks the child
    expect(canReadStoredFile(ctxFor("HR_MANAGER"), photoFile, access("student.photo"))).toBe(false);
  });
  it("without the module's owner assertion, nobody but Super Admin reads a private document; never anonymous", () => {
    expect(canReadStoredFile(ctxFor("SCHOOL_ADMIN"), docFile)).toBe(false);
    expect(canReadStoredFile(null, docFile, access("student.document"))).toBe(false);
    expect(canReadStoredFile(ctxFor("SUPER_ADMIN"), docFile)).toBe(true);
    expect(canReadStoredFile(ctxFor("SCHOOL_ADMIN", { mustChangePassword: true }), docFile, access("student.document"))).toBe(false);
  });
});

describe("upload form fields", () => {
  it("type from the fixed list; OTHER needs a description", () => {
    expect(documentUploadFieldsSchema.parse({ type: "BIRTH_CERTIFICATE", label: "  " })).toEqual({ type: "BIRTH_CERTIFICATE", label: null });
    expect(documentUploadFieldsSchema.safeParse({ type: "OTHER", label: "" }).success).toBe(false);
    expect(documentUploadFieldsSchema.parse({ type: "OTHER", label: " Caste  certificate " }).label).toBe("Caste certificate");
    expect(documentUploadFieldsSchema.safeParse({ type: "AADHAAR", label: "" }).success).toBe(false);
    expect(documentUploadFieldsSchema.safeParse({ type: "PHOTO", label: "", extra: 1 }).success).toBe(false);
  });
});
