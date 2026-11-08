"use client";

import { useActionState, useState, type ComponentProps, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FormStatus, SubmitButton } from "@/components/erp/form";
import { OneTimeSecret } from "@/components/erp/one-time-secret";
import { initialState, type ActionState } from "@/lib/action-state";

/**
 * Button → confirmation dialog → server action. Used for every destructive or
 * security-sensitive action (deactivate, reset password, sign out everywhere, delete).
 * Results (including one-time secrets) are shown after the dialog closes.
 */
export function ConfirmAction({
  label,
  title,
  description,
  confirmLabel,
  action,
  fields,
  variant = "outline",
  secretLabel,
  icon,
}: {
  label: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  fields: Record<string, string>;
  variant?: ComponentProps<typeof Button>["variant"];
  secretLabel?: string;
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction] = useActionState(async (prev: ActionState, fd: FormData) => {
    const result = await action(prev, fd);
    setOpen(false); // close the dialog; the result is shown beside the button
    return result;
  }, initialState);

  return (
    <div className="grid gap-2">
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button variant={variant} className="w-full justify-start sm:w-auto">
            {icon}
            {label}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <form action={formAction} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>{title}</AlertDialogTitle>
              <AlertDialogDescription>{description}</AlertDialogDescription>
            </AlertDialogHeader>
            {Object.entries(fields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
            <AlertDialogFooter>
              <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
              <SubmitButton variant={variant === "destructive" ? "destructive" : "default"}>{confirmLabel}</SubmitButton>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
      {state.secret ? <OneTimeSecret label={secretLabel ?? "Temporary password"} value={state.secret} message={state.message} /> : <FormStatus state={state} />}
    </div>
  );
}
