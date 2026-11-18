import { z } from "zod";
import { cleanText } from "./admissions.rules";

/** Fields of the document upload form (the file itself is validated by the route + upload rules). */
export const DOCUMENT_TYPES = ["PHOTO", "BIRTH_CERTIFICATE", "TRANSFER_CERTIFICATE", "PREVIOUS_MARKSHEET", "OTHER"] as const;

export const DOCUMENT_LABEL: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  PHOTO: "Student photo",
  BIRTH_CERTIFICATE: "Birth certificate",
  TRANSFER_CERTIFICATE: "Transfer certificate",
  PREVIOUS_MARKSHEET: "Previous marksheet",
  OTHER: "Other document",
};

export const documentUploadFieldsSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES, "Choose the document type."),
    label: z
      .string()
      .transform(cleanText)
      .pipe(z.string().max(80, "Use at most 80 characters."))
      .transform((v) => (v === "" ? null : v)),
  })
  .strict()
  .refine((v) => v.type !== "OTHER" || v.label !== null, { message: "Describe the document (e.g. Caste certificate).", path: ["label"] });

export type DocumentUploadFields = z.infer<typeof documentUploadFieldsSchema>;

export const documentRefSchema = z.object({ applicationId: z.string().trim().min(1).max(64), documentId: z.string().trim().min(1).max(64) }).strict();

/** Ids in route paths: cuid2 (applications) and 32-hex (documents). */
export const PATH_ID = /^[A-Za-z0-9]{10,64}$/;
