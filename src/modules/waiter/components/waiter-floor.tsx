"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { WaiterFloorView } from "@/modules/waiter/queries";
import { useLiveRefresh, useReadyAlert } from "@/modules/waiter/components/use-live-status";

interface Props {
  businessId: string;
  outlet: { id: string; name: string };
  outlets: { id: string; name: string }[];
  floor: WaiterFloorView;
}

/**
 * Phase 12 — touch floor plan. Tap a table to take or continue its order.
 * Tiles show the state a waiter acts on: free, occupied, bill requested, and
 * items the kitchen has finished (ready to serve).
 */
export function WaiterFloor({ businessId, outlet, outlets, floor }: Props) {
  useLiveRefresh(8000);

  const readyTotal = Object.values(floor.readyByOrder).reduce((sum, n) => sum + n, 0);
  useReadyAlert(readyTotal);

  const { plan, readyByOrder } = floor;
  const sections = [...plan.sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const activeTables = plan.tables.filter((t) => t.isActive);

  return (
    <div className="flex flex-col gap-5 p-4">
      {outlets.length > 1 ? (
        <nav aria-label="Outlets" className="flex gap-2 overflow-x-auto pb-1">
          {outlets.map((o) => (
            <Link
              key={o.id}
              href={`/waiter?business=${businessId}&outlet=${o.id}`}
              className={cn(
                "shrink-0 rounded-full border px-4 py-2.5 text-sm font-medium",
                o.id === outlet.id
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background",
              )}
            >
              {o.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {readyTotal > 0 ? (
        <div className="rounded-xl border border-emerald-600/40 bg-emerald-500/10 px-4 py-3 text-sm font-medium text-emerald-800 dark:text-emerald-300">
          {readyTotal} item{readyTotal === 1 ? "" : "s"} ready to serve.
        </div>
      ) : null}

      {sections.length === 0 ? (
        <p className="py-16 text-center text-base text-muted-foreground">
          No tables are set up for {outlet.name} yet. Ask a manager to add them in Floor.
        </p>
      ) : null}

      {sections.map((section) => {
        const tables = activeTables
          .filter((t) => t.sectionId === section.id)
          .sort((a, b) => a.sortOrder - b.sortOrder);
        if (tables.length === 0) return null;
        return (
          <section key={section.id} className="flex flex-col gap-2">
            <h2 className="font-display text-lg font-semibold">{section.name}</h2>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              {tables.map((table) => {
                const ready = table.order ? (readyByOrder[table.order.id] ?? 0) : 0;
                const billRequested = Boolean(table.order?.billRequestedAt);
                const occupied = table.status === "occupied" && Boolean(table.order);
                return (
                  <Link
                    key={table.id}
                    href={`/waiter/table/${table.id}?business=${businessId}&outlet=${outlet.id}`}
                    className={cn(
                      "flex min-h-28 flex-col justify-between rounded-2xl border-2 p-3 text-left transition-colors active:scale-[0.98]",
                      table.status === "reserved" && "border-dashed border-muted-foreground/40 text-muted-foreground",
                      table.status === "available" && "border-emerald-500/50 bg-emerald-500/5",
                      occupied && !billRequested && "border-amber-500/60 bg-amber-500/10",
                      billRequested && "border-rose-500 bg-rose-500/10",
                    )}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="font-display text-xl font-semibold">{table.label}</span>
                      {ready > 0 ? (
                        <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white">
                          {ready} ready
                        </span>
                      ) : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {occupied && table.order ? `Order #${table.order.orderNumber}` : `Seats ${table.capacity}`}
                    </span>
                    <span className="text-xs font-semibold">
                      {billRequested
                        ? "Bill requested"
                        : table.status === "occupied"
                          ? "Occupied"
                          : table.status === "reserved"
                            ? "Reserved"
                            : "Free"}
                    </span>
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
