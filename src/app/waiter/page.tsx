import type { Metadata } from "next";
import Link from "next/link";
import { resolveWaiterContext } from "@/modules/waiter/context";
import { loadWaiterFloor } from "@/modules/waiter/queries";
import { WaiterFloor } from "@/modules/waiter/components/waiter-floor";

export const metadata: Metadata = { title: "Waiter" };

export default async function WaiterFloorPage({
  searchParams,
}: {
  searchParams: Promise<{ business?: string; outlet?: string }>;
}) {
  const params = await searchParams;
  const ctx = await resolveWaiterContext(params);

  if (ctx.state === "no-access") {
    return (
      <Message
        title="Waiter app"
        body="Your role does not include taking orders. Ask an owner or manager to assign you to a waiter role."
      />
    );
  }

  if (ctx.state === "pick-business") {
    return (
      <div className="flex flex-col gap-3 p-4">
        <h1 className="font-display text-3xl font-semibold">Choose a business</h1>
        {ctx.businesses.map((b) => (
          <Link
            key={b.id}
            href={`/waiter?business=${b.id}`}
            className="flex min-h-14 items-center rounded-xl border border-border px-4 text-base font-medium"
          >
            {b.name}
          </Link>
        ))}
      </div>
    );
  }

  if (ctx.state === "no-outlet") {
    return (
      <Message
        title={ctx.business.name}
        body="No outlet is assigned to you yet. Ask an owner or manager to give you an outlet."
      />
    );
  }

  const floor = await loadWaiterFloor(ctx.outlet.id);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <p className="text-sm text-muted-foreground">{ctx.business.name}</p>
        <h1 className="font-display text-2xl font-semibold">Tables</h1>
      </header>
      <WaiterFloor
        businessId={ctx.business.id}
        outlet={ctx.outlet}
        outlets={ctx.outlets}
        floor={floor}
      />
    </div>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2 p-6">
      <h1 className="font-display text-2xl font-semibold">{title}</h1>
      <p className="text-base text-muted-foreground">{body}</p>
    </div>
  );
}
