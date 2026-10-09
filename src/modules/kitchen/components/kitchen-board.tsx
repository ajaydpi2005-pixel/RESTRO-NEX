"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Maximize2, Minimize2, Volume2, VolumeX, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ALL_FILTER,
  EVENT_REASON_LABEL,
  isActiveKitchenStatus,
  KITCHEN_STATUSES,
  NEXT_TARGET,
  STATUS_LABEL,
  UNROUTED_FILTER,
  type KitchenStatus,
  type KitchenTarget,
} from "../constants";
import {
  buildTickets,
  bumpableItems,
  stationCounts,
  ticketsByColumn,
  type KitchenEventRow,
  type KitchenItemRow,
  type StationRow,
  type Ticket,
} from "../board-logic";
import {
  acknowledgeEventAction,
  advanceItemAction,
  advanceTicketAction,
  loadKitchenSnapshotAction,
  setPriorityAction,
} from "../actions";
import { playCancelled, playNewTicket, unlockSound } from "../sound";
import { TicketCard } from "./ticket-card";
import { useKitchenRealtime, type ChangePayload, type ConnectionStatus } from "./use-kitchen-realtime";
import { useClock } from "./use-clock";

/**
 * Phase 11 — the live kitchen board for one outlet.
 *
 * Live updates: Postgres changes on kitchen_items / kitchen_events, delivered
 * by Supabase Realtime under RLS. Every (re)connect and every 30 seconds the
 * board re-reads a full snapshot, so anything missed while offline is healed.
 * Failed writes also trigger a re-read, so the screen never shows a state the
 * server rejected.
 */

const RESYNC_INTERVAL_MS = 30_000;
const MAX_EVENTS = 100;
const COLUMNS: readonly KitchenStatus[] = KITCHEN_STATUSES;
const COLUMN_TITLE: Record<KitchenStatus, string> = {
  new: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
};

// ── state ───────────────────────────────────────────────────────────────────

type ItemsState = Record<string, KitchenItemRow>;
type ItemsAction =
  | { type: "replace"; items: KitchenItemRow[] }
  | { type: "upsert"; item: KitchenItemRow }
  | { type: "remove"; id: string }
  | { type: "move"; ids: string[]; to: KitchenTarget; at: string }
  | { type: "priority"; orderId: string; priority: boolean };

function indexItems(items: readonly KitchenItemRow[]): ItemsState {
  const index: ItemsState = {};
  for (const item of items) index[item.id] = item;
  return index;
}

function itemsReducer(state: ItemsState, action: ItemsAction): ItemsState {
  switch (action.type) {
    case "replace":
      return indexItems(action.items);
    case "upsert":
      return { ...state, [action.item.id]: action.item };
    case "remove": {
      if (!(action.id in state)) return state;
      const next = { ...state };
      delete next[action.id];
      return next;
    }
    case "move": {
      const next = { ...state };
      for (const id of action.ids) {
        const current = next[id];
        if (!current) continue;
        if (action.to === "completed") {
          delete next[id];
        } else {
          next[id] = { ...current, kitchen_status: action.to, kitchen_status_at: action.at };
        }
      }
      return next;
    }
    case "priority": {
      const next = { ...state };
      for (const [id, item] of Object.entries(state)) {
        if (item.order_id === action.orderId) next[id] = { ...item, priority: action.priority };
      }
      return next;
    }
  }
}

type EventsAction =
  | { type: "replace"; events: KitchenEventRow[] }
  | { type: "add"; event: KitchenEventRow }
  | { type: "remove"; id: string };

function eventsReducer(state: KitchenEventRow[], action: EventsAction): KitchenEventRow[] {
  switch (action.type) {
    case "replace":
      return action.events.filter((e) => !e.acknowledged_at).slice(0, MAX_EVENTS);
    case "add":
      if (action.event.acknowledged_at || state.some((e) => e.id === action.event.id)) return state;
      return [action.event, ...state].slice(0, MAX_EVENTS);
    case "remove":
      return state.filter((e) => e.id !== action.id);
  }
}

// ── component ───────────────────────────────────────────────────────────────

export interface KitchenBoardProps {
  outletId: string;
  outletName: string;
  initialItems: KitchenItemRow[];
  initialEvents: KitchenEventRow[];
  initialStations: StationRow[];
  canOperate: boolean;
  canManage: boolean;
  routingHref: string;
}

export function KitchenBoard({
  outletId,
  outletName,
  initialItems,
  initialEvents,
  initialStations,
  canOperate,
  canManage,
  routingHref,
}: KitchenBoardProps) {
  const [items, dispatchItems] = useReducer(itemsReducer, initialItems, indexItems);
  const [events, dispatchEvents] = useReducer(eventsReducer, initialEvents, (list) =>
    list.filter((e) => !e.acknowledged_at),
  );
  const [stations, setStations] = useState<StationRow[]>(initialStations);
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [soundOn, setSoundOn] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  const rootRef = useRef<HTMLElement>(null);
  const soundRef = useRef(false);
  const connectionRef = useRef<ConnectionStatus>("connecting");
  const now = useClock();

  const activeStationIds = useMemo(
    () => new Set(stations.filter((s) => s.is_active).map((s) => s.id)),
    [stations],
  );
  const stationNameById = useMemo(() => new Map(stations.map((s) => [s.id, s.name])), [stations]);
  const itemList = useMemo(() => Object.values(items), [items]);
  const tickets = useMemo(() => buildTickets(itemList, activeStationIds, filter), [itemList, activeStationIds, filter]);
  const columns = useMemo(() => ticketsByColumn(tickets), [tickets]);
  const counts = useMemo(() => stationCounts(itemList, activeStationIds), [itemList, activeStationIds]);

  // ── data refresh ──────────────────────────────────────────────────────────

  const resync = useCallback(async () => {
    const result = await loadKitchenSnapshotAction({ outletId });
    if (!result.ok || !result.value) {
      if (!result.ok) setError(result.error);
      return;
    }
    dispatchItems({ type: "replace", items: result.value.items });
    dispatchEvents({ type: "replace", events: result.value.events });
    setStations(result.value.stations);
  }, [outletId]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void resync();
    }, RESYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [resync]);

  // ── realtime ──────────────────────────────────────────────────────────────

  const onItemChange = (payload: ChangePayload) => {
    if (payload.eventType === "DELETE") {
      const old = payload.old as { id?: string };
      if (old.id) dispatchItems({ type: "remove", id: old.id });
      return;
    }
    const row = payload.new as unknown as KitchenItemRow;
    if (!isActiveKitchenStatus(row.kitchen_status)) {
      // Completed or cancelled: the work is finished, so it leaves the board.
      dispatchItems({ type: "remove", id: row.id });
      return;
    }
    dispatchItems({ type: "upsert", item: row });
    if (payload.eventType === "INSERT" && row.kitchen_status === "new" && soundRef.current) {
      playNewTicket();
    }
  };

  const onEventChange = (payload: ChangePayload) => {
    if (payload.eventType === "DELETE") {
      const old = payload.old as { id?: string };
      if (old.id) dispatchEvents({ type: "remove", id: old.id });
      return;
    }
    const row = payload.new as unknown as KitchenEventRow;
    if (row.acknowledged_at) {
      dispatchEvents({ type: "remove", id: row.id });
      return;
    }
    dispatchEvents({ type: "add", event: row });
    if (payload.eventType === "INSERT" && soundRef.current) playCancelled();
  };

  const onStatus = (status: ConnectionStatus) => {
    // Coming back from a drop: re-read everything we may have missed.
    if (status === "live" && connectionRef.current === "reconnecting") void resync();
    connectionRef.current = status;
    setConnection(status);
  };

  useKitchenRealtime(outletId, { onItemChange, onEventChange, onStatus });

  // ── actions ───────────────────────────────────────────────────────────────

  const withBusy = async (key: string, task: () => Promise<void>) => {
    setBusy((prev) => new Set(prev).add(key));
    try {
      await task();
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const moveItem = (ticket: Ticket, item: KitchenItemRow, to: KitchenTarget) =>
    withBusy(ticket.key, async () => {
      dispatchItems({ type: "move", ids: [item.id], to, at: new Date().toISOString() });
      const result = await advanceItemAction({
        outletId,
        itemId: item.id,
        from: item.kitchen_status,
        to,
      });
      if (!result.ok) {
        setError(result.error);
        await resync();
      }
    });

  const bumpTicket = (ticket: Ticket) =>
    withBusy(ticket.key, async () => {
      const targets = bumpableItems(ticket);
      const from = ticket.status;
      const to = NEXT_TARGET[from];
      dispatchItems({ type: "move", ids: targets.map((i) => i.id), to, at: new Date().toISOString() });

      // The RPC matches a lane by its raw station id, so bump one lane per station.
      const lanes = [...new Set(targets.map((i) => i.station_id))];
      let moved = 0;
      for (const stationId of lanes) {
        const result = await advanceTicketAction({
          outletId,
          orderId: ticket.orderId,
          stationId,
          from,
          to,
        });
        if (!result.ok) {
          setError(result.error);
          await resync();
          return;
        }
        moved += result.value ?? 0;
      }
      if (moved !== targets.length) await resync();
    });

  const togglePriority = (ticket: Ticket) =>
    withBusy(ticket.key, async () => {
      const priority = !ticket.priority;
      dispatchItems({ type: "priority", orderId: ticket.orderId, priority });
      const result = await setPriorityAction({ outletId, orderId: ticket.orderId, priority });
      if (!result.ok) {
        setError(result.error);
        await resync();
      }
    });

  const acknowledge = async (event: KitchenEventRow) => {
    dispatchEvents({ type: "remove", id: event.id });
    const result = await acknowledgeEventAction({ outletId, eventId: event.id });
    if (!result.ok) {
      setError(result.error);
      await resync();
    }
  };

  // ── sound + full screen ───────────────────────────────────────────────────

  const toggleSound = () => {
    if (soundRef.current) {
      soundRef.current = false;
      setSoundOn(false);
      return;
    }
    const unlocked = unlockSound();
    if (!unlocked) {
      setError("Sound alerts are not supported in this browser.");
      return;
    }
    soundRef.current = true;
    setSoundOn(true);
  };

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await rootRef.current?.requestFullscreen();
      }
    } catch {
      setError("Full screen is not available in this browser.");
    }
  };

  // ── render ────────────────────────────────────────────────────────────────

  const stationTabs: { key: string; label: string }[] = [
    { key: ALL_FILTER, label: "All" },
    ...stations
      .filter((s) => s.is_active)
      .map((s) => ({ key: s.id, label: s.name })),
    { key: UNROUTED_FILTER, label: "Unrouted" },
  ];

  return (
    <section
      ref={rootRef}
      aria-label={`Kitchen board for ${outletName}`}
      className={cn(
        "space-y-4",
        isFullscreen && "fixed inset-0 z-50 overflow-auto bg-background p-4",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Kitchen display</h2>
          <p className="text-sm text-muted-foreground">{outletName} · live from POS orders</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionPill status={connection} />
          <Button
            type="button"
            variant={soundOn ? "default" : "outline"}
            size="lg"
            className="h-12 px-4"
            onClick={toggleSound}
            aria-pressed={soundOn}
          >
            {soundOn ? <Volume2 className="size-5" aria-hidden /> : <VolumeX className="size-5" aria-hidden />}
            {soundOn ? "Sound on" : "Enable sound"}
          </Button>
          <Button type="button" variant="outline" size="lg" className="h-12 px-4" onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 className="size-5" aria-hidden /> : <Maximize2 className="size-5" aria-hidden />}
            {isFullscreen ? "Exit full screen" : "Full screen"}
          </Button>
          {canManage ? (
            <Link
              href={routingHref}
              className="inline-flex h-12 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
            >
              <Settings2 className="size-5" aria-hidden />
              Routing
            </Link>
          ) : null}
        </div>
      </header>

      {connection === "reconnecting" ? (
        <div role="status" className="rounded-xl border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900">
          Live updates paused. The board refreshes every 30 seconds until the connection is back.
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-xl border border-red-500 bg-red-50 p-3 text-sm text-red-900">
          <span>{error}</span>
          <button type="button" className="shrink-0 font-medium underline" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {events.length > 0 ? (
        <div className="space-y-2" aria-live="assertive">
          {events.map((event) => (
            <div
              key={event.id}
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-red-600 bg-red-50 p-3"
            >
              <div>
                <p className="text-lg font-semibold text-red-900">
                  {EVENT_REASON_LABEL[event.reason] ?? "Cancelled"}: #{event.order_number} · {event.quantity}×{" "}
                  {event.item_name}
                </p>
                <p className="text-sm text-red-900/80">
                  Stop work on this item. It will not be served.
                </p>
              </div>
              {canOperate ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  className="h-12 px-5"
                  onClick={() => void acknowledge(event)}
                >
                  Acknowledge
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <nav aria-label="Station filter" className="flex flex-wrap gap-2">
        {stationTabs.map((tab) => {
          const count = counts.get(tab.key) ?? 0;
          const active = filter === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              aria-pressed={active}
              onClick={() => setFilter(tab.key)}
              className={cn(
                "inline-flex min-h-12 items-center gap-2 rounded-xl border px-4 text-base font-semibold transition-colors",
                active ? "border-ink bg-ink text-parchment" : "border-border bg-card hover:bg-muted",
              )}
            >
              {tab.label}
              <span
                className={cn(
                  "rounded-md px-2 py-0.5 text-sm tabular-nums",
                  active ? "bg-parchment/20" : "bg-muted text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </nav>

      {itemList.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <p className="font-medium">No live kitchen tickets</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Orders sent from the POS appear here within a second.
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-4">
        {COLUMNS.map((status) => (
          <section key={status} aria-label={`${COLUMN_TITLE[status]} tickets`} className="flex min-w-0 flex-col gap-3">
            <header className="flex items-center justify-between rounded-xl bg-muted px-4 py-3">
              <h3 className="text-lg font-semibold">{COLUMN_TITLE[status]}</h3>
              <span className="rounded-md bg-card px-2.5 py-0.5 font-mono text-base tabular-nums">
                {columns[status].length}
              </span>
            </header>
            {columns[status].length === 0 ? (
              <p className="px-1 text-sm text-muted-foreground">Nothing {STATUS_LABEL[status].toLowerCase()}.</p>
            ) : null}
            {columns[status].map((ticket) => (
              <TicketCard
                key={ticket.key}
                ticket={ticket}
                stationName={ticket.stationId ? (stationNameById.get(ticket.stationId) ?? null) : null}
                now={now}
                canOperate={canOperate}
                busyKeys={busy}
                onBump={bumpTicket}
                onMoveItem={(item, to) => void moveItem(ticket, item, to)}
                onTogglePriority={togglePriority}
              />
            ))}
          </section>
        ))}
      </div>
    </section>
  );
}

function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const config = {
    live: { label: "Live", dot: "bg-emerald-500", text: "text-emerald-900" },
    connecting: { label: "Connecting…", dot: "bg-muted-foreground", text: "text-muted-foreground" },
    reconnecting: { label: "Reconnecting", dot: "bg-amber-500", text: "text-amber-900" },
  }[status];
  return (
    <span
      role="status"
      className={cn("inline-flex h-12 items-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold", config.text)}
    >
      <span className={cn("size-2.5 rounded-full", config.dot)} aria-hidden />
      {config.label}
    </span>
  );
}
