import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { guardRedirect } from "@/lib/guarded-redirect";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import {
  CrmBusinessPicker,
  CrmDenied,
  CrmNav,
  CrmNoOutlet,
  SegmentBadge,
  rupees,
} from "@/modules/customers/components/crm-chrome";
import {
  AddressForm,
  CustomerForm,
  DeleteAddressButton,
} from "@/modules/customers/components/customer-forms";
import { PointsAdjustForm, RedeemRewardForm } from "@/modules/customers/components/loyalty-forms";
import { loadCustomerProfile, loadLoyaltySettings, loadRewards } from "@/modules/customers/queries";
import { SEGMENT_HINTS } from "@/modules/customers/segments";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await loadInventoryPageContext(query, "customers.view");
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <CrmBusinessPicker businesses={ctx.businesses} />;
  if (ctx.kind === "denied") return <CrmDenied />;
  if (ctx.kind === "no-outlet") return <CrmNoOutlet />;

  const { business, abilities, outlet } = ctx;
  const profile = await loadCustomerProfile(business.id, id);
  if (!profile) notFound();

  const canManage = abilities.can("customers.manage");
  const canRedeem = abilities.can("discounts.apply");
  const [settings, rewards] = await Promise.all([
    loadLoyaltySettings(business.id),
    loadRewards(business.id),
  ]);
  const base = `business=${business.id}&outlet=${outlet.id}`;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <p className="text-muted-foreground text-sm">
          <Link href={`/customers?${base}`} className="underline-offset-4 hover:underline">
            Customers
          </Link>{" "}
          / {profile.name}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">{profile.name}</h1>
          <SegmentBadge segment={profile.segment} />
        </div>
        <p className="text-muted-foreground">
          {profile.phone}
          {profile.email ? ` · ${profile.email}` : ""} · {SEGMENT_HINTS[profile.segment]}
        </p>
      </div>

      <CrmNav businessId={business.id} outletId={outlet.id} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Net spend" value={rupees(profile.totalSpendMinor)} />
        <Stat label="Completed orders" value={String(profile.orderCount)} />
        <Stat
          label="Last order"
          value={
            profile.lastOrderAt ? new Date(profile.lastOrderAt).toLocaleDateString("en-IN") : "—"
          }
        />
        <Stat label="Points balance" value={String(profile.balance)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Order history</CardTitle>
              <CardDescription>
                Latest 20 completed orders. Favourite products:{" "}
                {profile.favourites.length
                  ? profile.favourites.map((f) => `${f.name} (${f.quantity})`).join(", ")
                  : "none yet"}
                .
              </CardDescription>
            </CardHeader>
            <CardContent>
              {profile.orders.length === 0 ? (
                <p className="text-muted-foreground text-sm">No completed orders yet.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-left">
                    <tr>
                      <th className="py-2 font-medium">Order</th>
                      <th className="py-2 font-medium">Date</th>
                      <th className="py-2 text-right font-medium">Total</th>
                      <th className="py-2 text-right font-medium">Refunded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {profile.orders.map((o) => (
                      <tr key={o.id} className="border-t">
                        <td className="py-2">
                          <Link
                            className="underline-offset-4 hover:underline"
                            href={`/orders/${o.id}?business=${business.id}`}
                          >
                            #{o.orderNumber}
                          </Link>
                        </td>
                        <td className="text-muted-foreground py-2">
                          {new Date(o.createdAt).toLocaleDateString("en-IN")}
                        </td>
                        <td className="py-2 text-right tabular-nums">{rupees(o.totalMinor)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {o.refundedMinor > 0 ? rupees(o.refundedMinor) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Loyalty</CardTitle>
              <CardDescription>
                {settings.enabled
                  ? `Earning 1 point per ₹${(settings.earnMinorPerPoint / 100).toFixed(2).replace(/\.00$/, "")} of net spend on completed orders.`
                  : "Loyalty earning is off. Turn it on under Loyalty & coupons."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Points ledger</h3>
                {profile.ledger.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No points activity yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-muted-foreground text-left">
                        <tr>
                          <th className="py-2 font-medium">When</th>
                          <th className="py-2 font-medium">Activity</th>
                          <th className="py-2 text-right font-medium">Points</th>
                          <th className="py-2 text-right font-medium">Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {profile.ledger.map((t) => (
                          <tr key={t.id} className="border-t">
                            <td className="text-muted-foreground py-2">
                              {new Date(t.createdAt).toLocaleString("en-IN")}
                            </td>
                            <td className="py-2">
                              {LEDGER_LABEL[t.kind] ?? t.kind}
                              {t.reason ? (
                                <span className="text-muted-foreground block text-xs">
                                  {t.reason}
                                </span>
                              ) : null}
                            </td>
                            <td
                              className={`py-2 text-right tabular-nums ${t.points < 0 ? "text-destructive" : ""}`}
                            >
                              {t.points > 0 ? `+${t.points}` : t.points}
                            </td>
                            <td className="py-2 text-right tabular-nums">{t.balanceAfter}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Reward vouchers</h3>
                {profile.vouchers.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No vouchers issued yet.</p>
                ) : (
                  <ul className="divide-y text-sm">
                    {profile.vouchers.map((v) => (
                      <li key={v.id} className="flex flex-wrap justify-between gap-2 py-2">
                        <span>
                          {v.name}{" "}
                          <span className="text-muted-foreground">· {v.pointsSpent} pts</span>
                        </span>
                        <span className="text-muted-foreground">
                          {v.status === "issued"
                            ? "Unused"
                            : v.status === "applied"
                              ? "On an open order"
                              : "Used"}
                          {v.orderId ? (
                            <>
                              {" "}
                              ·{" "}
                              <Link
                                className="underline-offset-4 hover:underline"
                                href={`/orders/${v.orderId}?business=${business.id}`}
                              >
                                order
                              </Link>
                            </>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Issue a reward</h3>
                {canRedeem ? (
                  <RedeemRewardForm
                    businessId={business.id}
                    customerId={profile.id}
                    rewards={rewards}
                    balance={profile.balance}
                  />
                ) : (
                  <p className="text-muted-foreground text-sm">
                    Issuing rewards needs discount permission.
                  </p>
                )}
              </div>

              {canManage ? (
                <div className="space-y-2">
                  <h3 className="text-sm font-medium">Adjust points</h3>
                  <p className="text-muted-foreground text-xs">
                    Manual adjustments are recorded in the ledger with the reason. The balance
                    cannot go below zero.
                  </p>
                  <PointsAdjustForm businessId={business.id} customerId={profile.id} />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              {canManage ? (
                <CustomerForm
                  businessId={business.id}
                  customer={{
                    id: profile.id,
                    name: profile.name,
                    phone: profile.phone,
                    email: profile.email,
                    notes: profile.notes,
                  }}
                />
              ) : (
                <dl className="grid gap-2 text-sm">
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd>{profile.phone}</dd>
                  <dt className="text-muted-foreground">Email</dt>
                  <dd>{profile.email ?? "—"}</dd>
                  <dt className="text-muted-foreground">Notes</dt>
                  <dd>{profile.notes ?? "—"}</dd>
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Addresses</CardTitle>
              <CardDescription>
                Saved for reference. They are not used for delivery pricing.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {profile.addresses.length === 0 ? (
                <p className="text-muted-foreground text-sm">No saved addresses.</p>
              ) : (
                <ul className="divide-y text-sm">
                  {profile.addresses.map((a) => (
                    <li key={a.id} className="flex items-start justify-between gap-3 py-2">
                      <span>
                        <span className="font-medium">{a.label}</span>
                        <span className="text-muted-foreground block">{a.address}</span>
                      </span>
                      {canManage ? (
                        <DeleteAddressButton businessId={business.id} addressId={a.id} />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canManage ? <AddressForm businessId={business.id} customerId={profile.id} /> : null}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

const LEDGER_LABEL: Record<string, string> = {
  earn: "Earned on order",
  reversal: "Reversed on refund",
  redeem: "Spent on reward",
  adjust: "Manual adjustment",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}
