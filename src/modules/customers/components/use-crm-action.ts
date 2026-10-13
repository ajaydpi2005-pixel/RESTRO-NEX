"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CrmActionState } from "@/modules/customers/actions";

type CrmAction = (prev: CrmActionState | undefined, formData: FormData) => Promise<CrmActionState>;

/**
 * Shared wiring for the customer forms: runs a server action, refreshes the
 * page on success, optionally clears the form, and issues a fresh client
 * reference after each success so the next submission is not mistaken for a
 * retry.
 */
export function useCrmAction(action: CrmAction, options: { resetOnSuccess?: boolean } = {}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<CrmActionState | undefined, FormData>(
    action,
    undefined,
  );
  const [clientRef, setClientRef] = useState(() => crypto.randomUUID());
  const [seenState, setSeenState] = useState(state);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setClientRef(crypto.randomUUID());
  }

  useEffect(() => {
    if (!state?.ok) return;
    if (options.resetOnSuccess !== false) formRef.current?.reset();
    router.refresh();
    // The options object is constant per call site; only a new result should re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, router]);

  return { state, formAction, pending, formRef, clientRef };
}
