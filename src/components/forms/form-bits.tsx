"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ButtonComponentProps = React.ComponentProps<typeof Button>;

/** Shape shared by every server-action form state in the app. */
export interface FormActionState {
  ok?: boolean;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
}

/** First validation message for a field, if any. */
export function FieldError({ state, name }: { state: FormActionState | undefined; name: string }) {
  const message = state?.fieldErrors?.[name]?.[0];
  if (!message) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

/** Form-level error banner. */
export function FormError({ state }: { state: FormActionState | undefined }) {
  if (!state?.error) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
    >
      {state.error}
    </div>
  );
}

/** Success note (e.g. profile saved). */
export function FormSuccess({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-2.5 text-sm text-foreground"
    >
      {message}
    </div>
  );
}

/** Submit button with a pending spinner. Full-width unless told otherwise. */
export function SubmitButton({
  label,
  busyLabel,
  pending,
  className,
  variant,
  size,
}: {
  label: string;
  busyLabel: string;
  pending: boolean;
  className?: string;
  variant?: ButtonComponentProps["variant"];
  size?: ButtonComponentProps["size"];
}) {
  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={cn("w-full", className)}
      disabled={pending}
      aria-busy={pending}
    >
      {pending ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
      {pending ? busyLabel : label}
    </Button>
  );
}
