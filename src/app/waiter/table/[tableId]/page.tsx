import type { Metadata } from "next";
import Link from "next/link";
import { resolveWaiterContext } from "@/modules/waiter/context";
import { loadWaiterOrder } from "@/modules/waiter/queries";
import { loadFloorPlan } from "@/modules/floors/queries";
import { loadPosMenu } from "@/modules/orders/queries";
import { WaiterOrderScreen } from "@/modules/waiter/components/waiter-order-screen";

export const metadata: Metadata = { title: "Table order" };

export default async function WaiterTablePage({
  params,
  searchParams,
}: {
  params: Promise<{ tableId: string }>;
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const { tableId } = await params;
  const query = await searchParams;
  const ctx = await resolveWaiterContext(query);

  if (ctx.state !== "ready") {
    return (
      <div className="flex flex-col gap-3 p-6">
        <h1 className="font-display text-2xl font-semibold">Table</h1>
        <Link href="/waiter" className="text-base font-medium text-primary underline-offset-4 hover:underline">
          Back to tables
        </Link>
      </div>
    );
  }

  const plan = await loadFloorPlan(ctx.outlet.id);
  const table = plan.tables.find((t) => t.id === tableId);
  if (!table) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <h1 className="font-display text-2xl font-semibold">Table not found</h1>
        <Link
          href={`/waiter?business=${ctx.business.id}&outlet=${ctx.outlet.id}`}
          className="text-base font-medium text-primary underline-offset-4 hover:underline"
        >
          Back to tables
        </Link>
      </div>
    );
  }

  const [menu, order] = await Promise.all([
    loadPosMenu(ctx.business.id, ctx.outlet.id),
    table.order ? loadWaiterOrder(ctx.outlet.id, table.order.id) : Promise.resolve(null),
  ]);

  return (
    <WaiterOrderScreen
      businessId={ctx.business.id}
      outlet={ctx.outlet}
      table={{ id: table.id, label: table.label }}
      menu={menu}
      order={order}
    />
  );
}
