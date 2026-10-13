import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  CrmBusinessPicker,
  CrmDenied,
  CrmNav,
  CrmNoOutlet,
  discountLabel,
  rupees,
} from "@/modules/customers/components/crm-chrome";
import {
  CouponForm,
  LoyaltySettingsForm,
  RewardForm,
} from "@/modules/customers/components/loyalty-forms";
import { loadCoupons, loadLoyaltySettings, loadRewards } from "@/modules/customers/queries";

export const metadata: Metadata = { title: "Loyalty & coupons" };

export default async function LoyaltyPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params, "customers.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <CrmBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <CrmDenied />;
  if (ctx.kind === "no-outlet") return <CrmNoOutlet />;

  const { business, abilities, outlet } = ctx;
  const canManage = abilities.can("customers.manage");
  const [settings, rewards, coupons] = await Promise.all([
    loadLoyaltySettings(business.id),
    loadRewards(business.id),
    loadCoupons(business.id),
  ]);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-3xl font-semibold tracking-tight">
          Loyalty &amp; coupons
        </h1>
        <p className="text-muted-foreground">
          {business.name}. Points are earned on completed orders and spent on rewards.
        </p>
      </div>

      <CrmNav businessId={business.id} outletId={outlet.id} />

      <Card>
        <CardHeader>
          <CardTitle>Earn rules</CardTitle>
          <CardDescription>
            Points are floor(net spend ÷ rate), where net spend is the order total after discounts,
            minus refunds. Each order earns once. A full refund reverses the points it earned, up to
            the customer&apos;s balance.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage ? (
            <LoyaltySettingsForm businessId={business.id} settings={settings} />
          ) : (
            <p className="text-muted-foreground text-sm">
              Loyalty is {settings.enabled ? "on" : "off"} at {rupees(settings.earnMinorPerPoint)}{" "}
              per point. Changing it needs customer management access.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Rewards</CardTitle>
            <CardDescription>
              A customer spends points to get a single-use voucher. Apply it to an open order.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {rewards.length === 0 ? (
              <p className="text-muted-foreground text-sm">No rewards yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {rewards.map((r) => (
                  <li key={r.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{r.name}</span>
                      <span className="flex items-center gap-2">
                        <Badge variant={r.active ? "outline" : "secondary"}>
                          {r.active ? "Active" : "Paused"}
                        </Badge>
                        <span className="text-muted-foreground">
                          {r.pointsCost} pts · {discountLabel(r.discountType, r.discountValue)}
                        </span>
                      </span>
                    </div>
                    {canManage ? (
                      <details>
                        <summary className="text-gold-deep cursor-pointer text-xs font-medium">
                          Edit reward
                        </summary>
                        <div className="pt-3">
                          <RewardForm businessId={business.id} reward={r} />
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">Add a reward</h3>
                <RewardForm businessId={business.id} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Managing rewards needs customer management access.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Coupons</CardTitle>
            <CardDescription>
              Typed by the cashier on an open order. A coupon is used once per order and counts as
              used when the order completes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {coupons.length === 0 ? (
              <p className="text-muted-foreground text-sm">No coupons yet.</p>
            ) : (
              <ul className="divide-y text-sm">
                {coupons.map((c) => (
                  <li key={c.id} className="space-y-2 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="font-mono font-medium">{c.code}</span>
                        <span className="text-muted-foreground"> · {c.name}</span>
                      </span>
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Badge variant={c.active ? "outline" : "secondary"}>
                          {c.active ? "Active" : "Off"}
                        </Badge>
                        {discountLabel(c.discountType, c.discountValue)}
                        {c.usageLimit != null
                          ? ` · ${c.redeemed}/${c.usageLimit} used`
                          : ` · ${c.redeemed} used`}
                      </span>
                    </div>
                    {canManage ? (
                      <details>
                        <summary className="text-gold-deep cursor-pointer text-xs font-medium">
                          Edit coupon
                        </summary>
                        <div className="pt-3">
                          <CouponForm businessId={business.id} coupon={c} />
                        </div>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {canManage ? (
              <div className="space-y-2 border-t pt-4">
                <h3 className="text-sm font-medium">Add a coupon</h3>
                <CouponForm businessId={business.id} />
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">
                Managing coupons needs customer management access.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
