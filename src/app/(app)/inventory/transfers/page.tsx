import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadInventoryPageContext } from "@/modules/inventory/page-context";
import { guardRedirect } from "@/lib/guarded-redirect";
import {
  InventoryBusinessPicker,
  InventoryDenied,
  InventoryNoOutlet,
} from "@/modules/inventory/components/business-picker";
import { InventoryNav, OutletTabs } from "@/modules/inventory/components/inventory-chrome";
import { TransferForm } from "@/modules/inventory/components/transfer-form";
import { loadIngredients, loadTransfers } from "@/modules/inventory/queries";
import { loadPosOutlets } from "@/modules/orders/queries";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await loadInventoryPageContext(params);
  if (ctx === "redirect") return await guardRedirect("/settings");
  if (ctx.kind === "picker") return <InventoryBusinessPicker businesses={ctx.businesses} basePath="/inventory/transfers" />;
  if (ctx.kind === "denied") return <InventoryDenied />;
  if (ctx.kind === "no-outlet") return <InventoryNoOutlet />;

  const { business, abilities, outlet, outlets, role, membershipId } = ctx;
  const canManage = abilities.can("inventory.manage");

  // Names for every outlet in the business, so history reads correctly even
  // when the viewer is assigned to only some of them.
  const admin = createAdminClient();
  const { data: allOutlets } = await admin.from("outlets").select("id, name").eq("business_id", business.id);
  const names = new Map((allOutlets ?? []).map((o) => [o.id, o.name]));
  // Transfers need access to both ends, so the form offers only outlets the viewer manages.
  const manageable = canManage ? await loadPosOutlets(business.id, role, membershipId) : [];
  const [ingredients, history] = await Promise.all([loadIngredients(business.id), loadTransfers(business.id, names)]);
  const options = ingredients.filter((i) => i.active).map((i) => ({ id: i.id, name: i.name, unit: i.unit }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Transfers</h1>
          <p className="text-muted-foreground">
            {business.name}. Stock moves between outlets in batches. Expiry dates and costs travel with it.
          </p>
        </div>
        <OutletTabs businessId={business.id} outlets={outlets} activeId={outlet.id} path="/inventory/transfers" />
      </div>

      <InventoryNav businessId={business.id} outletId={outlet.id} />

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>New transfer</CardTitle>
            <CardDescription>
              You need inventory management at both outlets. Transfers are refused when the source does not hold enough usable stock.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {manageable.length >= 2 ? (
              <TransferForm
                businessId={business.id}
                outlets={manageable}
                defaultFrom={manageable.some((o) => o.id === outlet.id) ? outlet.id : manageable[0]!.id}
                ingredients={options}
              />
            ) : (
              <p className="text-sm text-muted-foreground">You need access to at least two outlets to transfer stock.</p>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent transfers</CardTitle>
          <CardDescription>The last 20 transfers in this business.</CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transfers yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {history.map((t) => (
                <li key={t.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <span className="font-medium">
                      {t.fromName} → {t.toName}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {new Date(t.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                    </span>
                  </div>
                  <div className="text-muted-foreground">{t.lines.join(" · ") || "No lines recorded"}</div>
                  {t.note ? <div className="text-muted-foreground">Note: {t.note}</div> : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
