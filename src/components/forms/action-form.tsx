"use client";

import { useActionState, useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  FormError,
  FormSuccess,
  SubmitButton,
  type FormActionState,
} from "@/components/forms/form-bits";
import { cn } from "@/lib/utils";

/**
 * Generic form that submits a server action and refreshes the route on success.
 * The server re-checks every permission. This component only renders the form.
 */
export function ActionForm<S extends FormActionState & { message?: string }>({
  action,
  submitLabel,
  busyLabel = "Saving…",
  children,
  className,
  variant,
}: {
  action: (previous: S | undefined, formData: FormData) => Promise<S>;
  submitLabel: string;
  busyLabel?: string;
  children: ReactNode;
  className?: string;
  variant?: React.ComponentProps<typeof SubmitButton>["variant"];
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<S | undefined, FormData>(action, undefined);

  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form action={formAction} className={cn("space-y-3", className)}>
      {children}
      <FormError state={state} />
      {state?.ok && state.message ? <FormSuccess message={state.message} /> : null}
      <SubmitButton label={submitLabel} busyLabel={busyLabel} pending={pending} variant={variant} />
    </form>
  );
}
