"use client";

import { useState } from "react";
import { SelectField, TextField } from "@/components/erp/form";
import { Button } from "@/components/ui/button";
import { checkFileSize } from "@/lib/storage/upload-limits";

interface Option {
  value: string;
  label: string;
}

/**
 * Plain multipart form to the dedicated upload route (never a server action — 10 MB, KI-048 pattern). The size is
 * pre-checked in the browser; the route and service re-check everything.
 */
export function StaffUploadForm({
  employeeId,
  types,
  maxBytes,
}: {
  employeeId: string;
  types: Option[];
  maxBytes: number;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      method="post"
      action={`/api/v1/employees/${employeeId}/documents`}
      encType="multipart/form-data"
      className="grid gap-3 rounded-lg border p-3"
      onSubmit={(e) => {
        const input = e.currentTarget.elements.namedItem(
          "file",
        ) as HTMLInputElement | null;
        const message = checkFileSize(input?.files?.[0], maxBytes);
        setError(message);
        if (message) e.preventDefault();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="Document type"
          id="sd-type"
          name="type"
          options={types}
          defaultValue={types[0]?.value}
          required
        />
        <TextField
          label="Description (needed for “Other”)"
          id="sd-label"
          name="label"
          maxLength={80}
          placeholder="e.g. Training certificate"
        />
      </div>
      <div className="grid gap-1.5">
        <label htmlFor="sd-file" className="text-sm font-medium">
          File
        </label>
        <input
          id="sd-file"
          name="file"
          type="file"
          required
          accept="application/pdf,image/jpeg,image/png"
          aria-describedby={`sd-hint${error ? " sd-error" : ""}`}
          className="min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1"
        />
        <p id="sd-hint" className="text-xs text-muted-foreground">
          PDF, JPEG or PNG, up to {Math.round(maxBytes / 1024 / 1024)} MB.
          Photos are cropped to a square and all hidden data (such as location)
          is removed. Never upload Aadhaar or PAN copies.
        </p>
        {error && (
          <p id="sd-error" role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" className="w-full sm:w-fit">
        Upload
      </Button>
    </form>
  );
}
