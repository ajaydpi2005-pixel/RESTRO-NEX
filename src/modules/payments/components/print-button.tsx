"use client";

import * as React from "react";
import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { printReceiptAction, type PaymentActionState } from "@/modules/payments/actions";

/** Plain browser print for documents that are not tracked (invoices, KOTs). */
export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <Button type="button" variant="outline" className="h-9 print:hidden" onClick={() => window.print()}>
      <Printer /> {label}
    </Button>
  );
}

/**
 * Receipt print: the server registers the print first (the first print is
 * normal, later ones are audited as reprints), and only then does the browser
 * print. If registration fails, nothing is printed.
 */
export function PrintReceiptButton({
  businessId,
  receiptId,
  printCount,
  canPrint,
}: {
  businessId: string;
  receiptId: string;
  printCount: number;
  canPrint: boolean;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<PaymentActionState | undefined, FormData>(
    printReceiptAction,
    undefined,
  );

  React.useEffect(() => {
    if (state?.ok) {
      window.print();
      router.refresh();
    }
  }, [state, router]);

  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      {canPrint ? (
        <form action={action}>
          <input type="hidden" name="businessId" value={businessId} />
          <input type="hidden" name="receiptId" value={receiptId} />
          <Button type="submit" variant="outline" className="h-9" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Printer />} Print receipt
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted-foreground">Printing receipts requires billing permission.</p>
      )}
      <span className="text-xs text-muted-foreground">
        {printCount === 0 ? "Not printed yet" : `Printed ${printCount} time${printCount === 1 ? "" : "s"}`}
      </span>
      {state?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
