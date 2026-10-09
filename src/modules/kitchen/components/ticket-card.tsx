"use client";

import { Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ACTION_LABEL,
  NEXT_TARGET,
  ORDER_TYPE_LABEL,
  STATUS_LABEL,
  type KitchenStatus,
  type KitchenTarget,
} from "../constants";
import {
  bumpableItems,
  formatElapsed,
  timerTone,
  type KitchenItemRow,
  type Ticket,
  type TimerTone,
} from "../board-logic";

/**
 * Phase 11 — one station ticket for one order. Touch-first: every control is
 * at least 48px tall and nothing depends on hover.
 */

const TONE_CARD: Record<TimerTone, string> = {
  calm: "border-border",
  warn: "border-amber-500",
  late: "border-red-600",
};

const TONE_CHIP: Record<TimerTone, string> = {
  calm: "bg-muted text-foreground",
  warn: "bg-amber-100 text-amber-900",
  late: "bg-red-600 text-white",
};

const STATUS_CHIP: Record<KitchenStatus, string> = {
  new: "bg-sky-100 text-sky-900",
  accepted: "bg-violet-100 text-violet-900",
  preparing: "bg-amber-100 text-amber-900",
  ready: "bg-emerald-100 text-emerald-900",
};

export interface TicketCardProps {
  ticket: Ticket;
  stationName: string | null;
  now: number | null;
  canOperate: boolean;
  busyKeys: ReadonlySet<string>;
  onBump: (ticket: Ticket) => void;
  onMoveItem: (item: KitchenItemRow, to: KitchenTarget) => void;
  onTogglePriority: (ticket: Ticket) => void;
}

export function TicketCard({
  ticket,
  stationName,
  now,
  canOperate,
  busyKeys,
  onBump,
  onMoveItem,
  onTogglePriority,
}: TicketCardProps) {
  const orderAge = now === null ? null : now - Date.parse(ticket.sentAt);
  const tone: TimerTone = orderAge === null ? "calm" : timerTone(orderAge);
  const busy = busyKeys.has(ticket.key);
  const bumpCount = bumpableItems(ticket).length;
  const orderTypeLabel = ORDER_TYPE_LABEL[ticket.orderType] ?? ticket.orderType;

  return (
    <article
      aria-label={`Order ${ticket.orderNumber}, ${STATUS_LABEL[ticket.status]}`}
      className={cn(
        "flex flex-col gap-3 rounded-2xl border-2 bg-card p-4 shadow-sm transition-colors",
        TONE_CARD[tone],
        ticket.priority && "ring-4 ring-amber-400/70",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-display text-4xl leading-none font-semibold tracking-tight">
            #{ticket.orderNumber}
          </p>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {orderTypeLabel}
            {ticket.tableLabel ? ` · Table ${ticket.tableLabel}` : ""}
            {stationName ? ` · ${stationName}` : " · Unrouted"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span
            className={cn("rounded-lg px-3 py-1 font-mono text-lg font-semibold tabular-nums", TONE_CHIP[tone])}
            aria-label={orderAge === null ? "Order age" : `Order age ${formatElapsed(orderAge)}`}
          >
            {orderAge === null ? "--:--" : formatElapsed(orderAge)}
          </span>
          <button
            type="button"
            disabled={!canOperate || busy}
            onClick={() => onTogglePriority(ticket)}
            aria-pressed={ticket.priority}
            className={cn(
              "inline-flex min-h-12 min-w-12 items-center justify-center gap-1 rounded-xl border px-3 text-sm font-semibold transition-colors disabled:opacity-50",
              ticket.priority
                ? "border-amber-500 bg-amber-400 text-ink"
                : "border-border bg-card text-foreground hover:bg-muted",
            )}
          >
            <Star className="size-5" aria-hidden fill={ticket.priority ? "currentColor" : "none"} />
            {ticket.priority ? "Priority" : "Mark"}
          </button>
        </div>
      </header>

      <ul className="flex flex-col gap-2">
        {ticket.items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            now={now}
            canOperate={canOperate && !busy}
            onMove={onMoveItem}
          />
        ))}
      </ul>

      {canOperate ? (
        <Button
          type="button"
          size="lg"
          variant={ticket.status === "ready" ? "default" : "secondary"}
          disabled={busy || bumpCount === 0}
          onClick={() => onBump(ticket)}
          className="h-14 w-full text-lg font-semibold"
        >
          {busy ? "Updating…" : `${ACTION_LABEL[ticket.status]} ${bumpCount > 1 ? `all ${bumpCount}` : "ticket"}`}
        </Button>
      ) : null}
    </article>
  );
}

interface ItemRowProps {
  item: KitchenItemRow;
  now: number | null;
  canOperate: boolean;
  onMove: (item: KitchenItemRow, to: KitchenTarget) => void;
}

function ItemRow({ item, now, canOperate, onMove }: ItemRowProps) {
  const itemAge = now === null ? null : now - Date.parse(item.kitchen_status_at);
  const itemTone: TimerTone = itemAge === null ? "calm" : timerTone(itemAge);

  return (
    <li className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg leading-snug font-semibold">
            <span className="tabular-nums">{item.quantity}×</span> {item.item_name}
          </p>
          {item.modifiers.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              {item.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name)).join(" · ")}
            </p>
          ) : null}
          {item.item_notes ? (
            <p className="mt-1 rounded-md bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
              Note: {item.item_notes}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("rounded-md px-2 py-0.5 text-xs font-semibold", STATUS_CHIP[item.kitchen_status])}>
            {STATUS_LABEL[item.kitchen_status]}
          </span>
          <span
            className={cn("rounded px-1.5 py-0.5 font-mono text-xs tabular-nums", TONE_CHIP[itemTone])}
            aria-label={itemAge === null ? "Item time" : `In status ${formatElapsed(itemAge)}`}
          >
            {itemAge === null ? "--:--" : formatElapsed(itemAge)}
          </span>
        </div>
      </div>
      {canOperate ? (
        <Button
          type="button"
          variant="outline"
          className="mt-2 h-12 w-full text-base"
          onClick={() => onMove(item, NEXT_TARGET[item.kitchen_status])}
        >
          {ACTION_LABEL[item.kitchen_status]} this item
        </Button>
      ) : null}
    </li>
  );
}
