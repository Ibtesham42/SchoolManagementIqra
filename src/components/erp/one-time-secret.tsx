"use client";

import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/** Shows a secret exactly once (it is not stored anywhere retrievable). */
export function OneTimeSecret({ label, value, message }: { label: string; value: string; message?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert role="status">
      <KeyRound aria-hidden="true" />
      <AlertTitle>{label}</AlertTitle>
      <AlertDescription className="grid gap-2">
        {message && <span>{message}</span>}
        <code className="w-fit rounded-md bg-muted px-2 py-1 font-mono text-base tracking-wider text-foreground" data-testid="one-time-secret">
          {value}
        </code>
        <span className="text-xs">Share it privately. It will not be shown again; the user must change it at first sign-in.</span>
        <Button
          type="button"
          variant="outline"
          className="w-fit"
          onClick={async () => {
            await navigator.clipboard?.writeText(value).catch(() => undefined);
            setCopied(true);
          }}
        >
          <Copy aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
