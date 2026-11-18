import { BadgeCheck, Eye, Trash2 } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { isUploadCode, STAFF_UPLOAD_MESSAGES } from "@/lib/http/upload-errors";
import { DOCUMENT_MAX_BYTES, formatBytes } from "@/lib/storage/upload-limits";
import {
  EMPLOYEE_DOCUMENT_LABEL,
  EMPLOYEE_DOCUMENT_TYPES,
} from "@/modules/hr/hr.schemas";
import type { listEmployeeDocuments } from "@/modules/hr/employee-documents.service";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmAction } from "@/components/erp/confirm-action";
import {
  removeEmployeeDocumentAction,
  verifyEmployeeDocumentAction,
} from "../../actions";
import { StaffUploadForm } from "./staff-upload-form";

type Docs = NonNullable<Awaited<ReturnType<typeof listEmployeeDocuments>>>;

/**
 * Documents of one employee (personal tier only — the page passes null otherwise). `uploadCode` comes from the upload
 * route's 303 redirect and is only ever mapped to fixed text.
 */
export function DocumentsCard({
  employeeId,
  docs,
  canManage,
  uploadCode,
  timeZone,
}: {
  employeeId: string;
  docs: Docs;
  canManage: boolean;
  uploadCode?: string;
  timeZone?: string;
}) {
  const url = (docId: string) =>
    `/api/v1/employees/${employeeId}/documents/${docId}`;
  const label = (t: string) =>
    EMPLOYEE_DOCUMENT_LABEL[t as keyof typeof EMPLOYEE_DOCUMENT_LABEL] ?? t;
  const files = docs.filter((d) => d.type !== "PHOTO");
  return (
    <Card id="documents">
      <CardHeader>
        <CardTitle>
          <h2>Documents</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {uploadCode && isUploadCode(uploadCode) && (
          <Alert
            variant={uploadCode === "ok" ? "default" : "destructive"}
            role={uploadCode === "ok" ? "status" : "alert"}
          >
            <AlertDescription>
              {STAFF_UPLOAD_MESSAGES[uploadCode]}
            </AlertDescription>
          </Alert>
        )}
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No documents uploaded yet.
          </p>
        ) : (
          <ul className="grid gap-2">
            {files.map((d) => (
              <li
                key={d.id}
                className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center"
              >
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
                    {d.file.originalName} · {formatBytes(d.file.sizeBytes)} ·{" "}
                    {formatDateTime(d.createdAt, timeZone)}
                    {d.uploadedBy ? ` · ${d.uploadedBy.displayName}` : ""}
                    {d.verifiedBy && d.verifiedAt
                      ? ` · verified by ${d.verifiedBy.displayName}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    asChild
                    variant="outline"
                    className="w-full justify-start sm:w-auto"
                  >
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
                      action={verifyEmployeeDocumentAction}
                      fields={{ employeeId, documentId: d.id }}
                    />
                  )}
                  {canManage && (
                    <ConfirmAction
                      label="Remove"
                      icon={<Trash2 aria-hidden="true" />}
                      variant="destructive"
                      title={`Remove ${label(d.type).toLowerCase()}?`}
                      description="The file is retired (no longer shown) and permanently deleted after 30 days. The record of it stays in the audit trail."
                      confirmLabel="Remove"
                      action={removeEmployeeDocumentAction}
                      fields={{ employeeId, documentId: d.id }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <StaffUploadForm
            employeeId={employeeId}
            maxBytes={DOCUMENT_MAX_BYTES}
            types={EMPLOYEE_DOCUMENT_TYPES.map((t) => ({
              value: t,
              label: EMPLOYEE_DOCUMENT_LABEL[t],
            }))}
          />
        )}
      </CardContent>
    </Card>
  );
}
