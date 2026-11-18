import { BadgeCheck, Eye, Trash2 } from "lucide-react";
import { hasPermission, type AuthContext } from "@/lib/rbac/authorize";
import { formatDateTime } from "@/lib/format";
import { isUploadCode, UPLOAD_MESSAGES } from "@/lib/http/upload-errors";
import { DOCUMENT_MAX_BYTES, formatBytes } from "@/lib/storage/upload-limits";
import { canDo, type AdmissionStatus } from "@/modules/admissions/admissions.rules";
import { DOCUMENT_LABEL, DOCUMENT_TYPES } from "@/modules/admissions/documents.schemas";
import { listApplicationDocuments } from "@/modules/admissions/documents.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/erp/confirm-action";
import { removeDocumentAction, verifyDocumentAction } from "./actions";
import { UploadDocumentForm } from "./forms";

/**
 * Server-rendered documents of one application: list (view / verify / remove), photo preview and the
 * upload form. `uploadCode` comes from the route's 303 redirect and is only ever mapped to fixed text.
 */
export async function DocumentsPanel({ ctx, applicationId, status, from, uploadCode, missing, timeZone }: {
  ctx: AuthContext;
  applicationId: string;
  status: AdmissionStatus;
  from: "edit" | "detail";
  uploadCode?: string;
  missing: string[];
  timeZone: string;
}) {
  const canRead = hasPermission(ctx, "student.document.read");
  const canManage = hasPermission(ctx, "student.document.manage") && canDo("manageDocuments", status);
  const docs = canRead ? await listApplicationDocuments(ctx, applicationId) : [];
  const photo = docs.find((d) => d.type === "PHOTO");
  const url = (docId: string) => `/api/v1/admissions/${applicationId}/documents/${docId}`;
  const label = (t: string) => DOCUMENT_LABEL[t as keyof typeof DOCUMENT_LABEL] ?? t;

  return (
    <div className="grid gap-4">
      {uploadCode && isUploadCode(uploadCode) && (
        <Alert variant={uploadCode === "ok" ? "default" : "destructive"} role={uploadCode === "ok" ? "status" : "alert"}>
          <AlertDescription>{UPLOAD_MESSAGES[uploadCode]}</AlertDescription>
        </Alert>
      )}
      {missing.length > 0 && (
        <p className="text-sm text-muted-foreground">Still needed (doesn&apos;t block approval): {missing.map(label).join(", ")}.</p>
      )}
      {!canRead ? (
        <p className="text-sm text-muted-foreground">You can&apos;t view documents.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <div className="flex size-32 items-center justify-center overflow-hidden rounded-lg border bg-muted text-xs text-muted-foreground">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element -- private, authorized route; not optimisable by next/image
              <img src={url(photo.id)} alt="Student photo" className="size-full object-cover" />
            ) : (
              "No photo"
            )}
          </div>
          {docs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No documents uploaded yet.</p>
          ) : (
            <ul className="grid gap-2">
              {docs.map((d) => (
                <li key={d.id} className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {label(d.type)}
                      {d.label ? ` — ${d.label}` : ""}{" "}
                      {d.verifiedAt ? (
                        <Badge variant="default">
                          <BadgeCheck aria-hidden="true" /> Verified
                        </Badge>
                      ) : (
                        <Badge variant="outline">Not verified</Badge>
                      )}
                    </p>
                    <p className="truncate text-muted-foreground">
                      {d.file.originalName} · {formatBytes(d.file.sizeBytes)} · {formatDateTime(d.createdAt, timeZone)}
                      {d.uploadedBy ? ` · ${d.uploadedBy.displayName}` : ""}
                      {d.verifiedBy && d.verifiedAt ? ` · verified by ${d.verifiedBy.displayName}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button asChild variant="outline" className="w-full justify-start sm:w-auto">
                      <a href={url(d.id)} target="_blank" rel="noopener">
                        <Eye aria-hidden="true" /> View
                      </a>
                    </Button>
                    {canManage && !d.verifiedAt && (
                      <ConfirmAction
                        label="Verify"
                        icon={<BadgeCheck aria-hidden="true" />}
                        title={`Mark ${label(d.type).toLowerCase()} as verified?`}
                        description="Confirms the upload was checked against the original. Your name and the time are recorded."
                        confirmLabel="Mark verified"
                        action={verifyDocumentAction}
                        fields={{ applicationId, documentId: d.id }}
                      />
                    )}
                    {canManage && (
                      <ConfirmAction
                        label="Remove"
                        icon={<Trash2 aria-hidden="true" />}
                        variant="destructive"
                        title={`Remove ${label(d.type).toLowerCase()}?`}
                        description="The file is retired (kept for the audit trail, no longer shown). Upload a new one if needed."
                        confirmLabel="Remove"
                        action={removeDocumentAction}
                        fields={{ applicationId, documentId: d.id }}
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canManage && <UploadDocumentForm applicationId={applicationId} from={from} maxBytes={DOCUMENT_MAX_BYTES} types={DOCUMENT_TYPES.map((t) => ({ value: t, label: DOCUMENT_LABEL[t] }))} />}
    </div>
  );
}
