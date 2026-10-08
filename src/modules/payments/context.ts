import { hasPermission } from "@/lib/rbac/permissions";
import { getManagedBusinesses } from "@/modules/business/queries";

/**
 * Phase 10 — business resolution for billing pages. Same pattern as the
 * orders/floor context, but gated on billing.view or reports.view.
 */
export interface PaymentsBusiness {
  id: string;
  name: string;
  role: string;
}

export async function resolvePaymentsBusiness(
  paramBusiness: string | undefined,
): Promise<{ withBillingView: PaymentsBusiness[]; business: PaymentsBusiness | undefined }> {
  const businesses = await getManagedBusinesses();
  const withBillingView = businesses.filter(
    (b) => hasPermission(b.role, "billing.view") || hasPermission(b.role, "reports.view"),
  );
  const business = paramBusiness
    ? withBillingView.find((b) => b.id === paramBusiness)
    : withBillingView.length === 1
      ? withBillingView[0]
      : undefined;
  return { withBillingView, business };
}
