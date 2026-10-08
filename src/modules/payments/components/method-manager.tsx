"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { savePaymentMethodAction, type PaymentActionState } from "@/modules/payments/actions";
import { PAYMENT_METHOD_KINDS, type PaymentMethodKind } from "@/modules/payments/schemas";
import type { MethodOption } from "@/modules/payments/queries";

const KIND_LABELS: Record<PaymentMethodKind, string> = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  other: "Other",
};

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";

function useRefreshOnResult(state: PaymentActionState | undefined) {
  const router = useRouter();
  React.useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);
}

function MethodFields({ method }: { method?: MethodOption }) {
  return (
    <>
      <Input
        name="label"
        aria-label="Label"
        defaultValue={method?.label ?? ""}
        placeholder="Label, e.g. Paytm"
        maxLength={40}
        required
        className="h-9 min-w-40 flex-1"
      />
      <select name="kind" aria-label="Type" defaultValue={method?.kind ?? "other"} className={selectClass}>
        {PAYMENT_METHOD_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABELS[k]}
          </option>
        ))}
      </select>
      <select
        name="requiresReference"
        aria-label="Reference required"
        defaultValue={method?.requiresReference ? "true" : "false"}
        className={selectClass}
      >
        <option value="false">No reference</option>
        <option value="true">Reference required</option>
      </select>
      <select name="isActive" aria-label="Status" defaultValue={method?.isActive === false ? "false" : "true"} className={selectClass}>
        <option value="true">Active</option>
        <option value="false">Inactive</option>
      </select>
    </>
  );
}

function MethodRow({ businessId, method }: { businessId: string; method: MethodOption }) {
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    savePaymentMethodAction,
    undefined,
  );
  useRefreshOnResult(state);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="methodId" value={method.id} />
      <input type="hidden" name="key" value={method.key} />
      <Badge className="border-0 bg-muted text-muted-foreground">{method.key}</Badge>
      <MethodFields method={method} />
      <Button type="submit" variant="outline" className="h-9" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null} Save
      </Button>
      {state?.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function NewMethodRow({ businessId }: { businessId: string }) {
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    savePaymentMethodAction,
    undefined,
  );
  useRefreshOnResult(state);
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border p-3">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="methodId" value="" />
      <Input
        name="key"
        aria-label="Method key"
        placeholder="key, e.g. paytm"
        pattern="[a-z][a-z0-9_]{1,30}"
        required
        className="h-9 w-40"
      />
      <MethodFields />
      <Button type="submit" className="h-9" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : null} Add method
      </Button>
      {state?.error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function PaymentMethodManager({
  businessId,
  methods,
  canManage,
}: {
  businessId: string;
  methods: MethodOption[];
  canManage: boolean;
}) {
  if (!canManage) {
    return (
      <ul className="grid gap-2 sm:grid-cols-2">
        {methods.map((m) => (
          <li key={m.key} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
            <span className="font-medium">{m.label}</span>
            <span className="text-xs text-muted-foreground">{m.isActive ? KIND_LABELS[m.kind] : "Inactive"}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="space-y-3">
      {methods.map((m) => (
        <MethodRow key={m.key} businessId={businessId} method={m} />
      ))}
      <NewMethodRow businessId={businessId} />
    </div>
  );
}
