"use client";

import { useActionState, useState, type ChangeEvent, type FormEvent } from "react";
import { Upload } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { initialState } from "@/lib/action-state";
import { checkFileSize, LOGO_MAX_BYTES } from "@/lib/storage/upload-limits";
import { uploadLogoAction } from "./actions";

/**
 * The server validates the file's actual content and size; `accept` only filters the picker.
 * The size is also checked here before submitting: Next.js rejects request bodies over 1 MB
 * before the server action runs, which would show the generic error page instead of this message.
 */
export function LogoForm() {
  const [state, action] = useActionState(uploadLogoAction, initialState);
  const [tooLarge, setTooLarge] = useState<string | null>(null);
  const error = tooLarge ?? state.fieldErrors?.file;

  const onChange = (e: ChangeEvent<HTMLInputElement>) => setTooLarge(checkFileSize(e.currentTarget.files?.[0], LOGO_MAX_BYTES));
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    const input = e.currentTarget.elements.namedItem("logo");
    const problem = input instanceof HTMLInputElement ? checkFileSize(input.files?.[0], LOGO_MAX_BYTES) : null;
    setTooLarge(problem);
    if (problem) e.preventDefault(); // never send an oversized body
  };

  return (
    <form action={action} onSubmit={onSubmit} className="grid gap-3">
      <FormStatus state={tooLarge ? { error: tooLarge } : state} />
      <div className="grid gap-1.5">
        <Label htmlFor="logo">Upload a new logo</Label>
        <Input
          id="logo"
          name="logo"
          type="file"
          accept="image/png,image/jpeg"
          onChange={onChange}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "logo-error" : "logo-hint"}
          required
        />
        <p id="logo-hint" className="text-xs text-muted-foreground">
          PNG or JPEG, up to 800 KB.
        </p>
        {error && (
          <p id="logo-error" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <SubmitButton variant="outline" className="w-full sm:w-fit" pendingLabel="Uploading…">
        <Upload aria-hidden="true" /> Upload logo
      </SubmitButton>
    </form>
  );
}
