"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { RoutingData } from "../queries";
import { loadRoutingAction, saveRoutesAction, saveStationsAction } from "../actions";

/**
 * Phase 11 — kitchen stations and routing (kitchen.manage).
 *
 * Resolution at send time: item route → category route → Unrouted. Combos use
 * their own route. Saving routes replaces this outlet's routes in one
 * transaction. Stations are never deleted: a removed station is deactivated,
 * so in-flight tickets keep their station and new items fall back to Unrouted.
 */

const MAX_STATIONS = 20;

interface StationDraft {
  key: string;
  name: string;
  description: string;
}

interface RouteDraft {
  category: Record<string, string>;
  item: Record<string, string>;
  combo: Record<string, string>;
}

function stationDrafts(stations: RoutingData["stations"]): StationDraft[] {
  return stations.map((s) => ({ key: s.id, name: s.name, description: s.description ?? "" }));
}

function routeDrafts(data: RoutingData): RouteDraft {
  const activeIds = new Set(data.stations.map((s) => s.id));
  const pick = (type: "category" | "item" | "combo") => {
    const map: Record<string, string> = {};
    for (const route of data.routes) {
      if (route.target_type === type && activeIds.has(route.station_id)) {
        map[route.target_id] = route.station_id;
      }
    }
    return map;
  };
  return { category: pick("category"), item: pick("item"), combo: pick("combo") };
}

type Notice = { tone: "ok" | "error"; text: string } | null;

export function RoutingManager({
  outletId,
  outletName,
  initial,
  backHref,
}: {
  outletId: string;
  outletName: string;
  initial: RoutingData;
  backHref: string;
}) {
  const [data, setData] = useState<RoutingData>(initial);
  const [stations, setStations] = useState<StationDraft[]>(() => stationDrafts(initial.stations));
  const [routes, setRoutes] = useState<RouteDraft>(() => routeDrafts(initial));
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();

  const itemsByCategory = new Map<string, RoutingData["items"]>();
  for (const item of data.items) {
    const list = itemsByCategory.get(item.category_id) ?? [];
    list.push(item);
    itemsByCategory.set(item.category_id, list);
  }

  const refreshData = async (): Promise<RoutingData | null> => {
    const result = await loadRoutingAction({ outletId });
    if (!result.ok || !result.value) {
      setNotice({ tone: "error", text: result.ok ? "Could not reload routing." : result.error });
      return null;
    }
    setData(result.value);
    return result.value;
  };

  const addStation = () => {
    if (stations.length >= MAX_STATIONS) return;
    setStations((prev) => [...prev, { key: `new-${crypto.randomUUID()}`, name: "", description: "" }]);
  };

  const updateStation = (key: string, patch: Partial<StationDraft>) =>
    setStations((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const removeStation = (key: string) => setStations((prev) => prev.filter((s) => s.key !== key));

  const saveStations = () =>
    startTransition(async () => {
      setNotice(null);
      const result = await saveStationsAction({
        outletId,
        stations: stations.map((s) => ({ name: s.name, description: s.description || null })),
      });
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      const fresh = await refreshData();
      if (fresh) {
        // Keep unsaved route choices, but drop any that point at a station just deactivated.
        const active = new Set(fresh.stations.map((s) => s.id));
        const keep = (map: Record<string, string>) =>
          Object.fromEntries(Object.entries(map).filter(([, stationId]) => active.has(stationId)));
        setStations(stationDrafts(fresh.stations));
        setRoutes((prev) => ({ category: keep(prev.category), item: keep(prev.item), combo: keep(prev.combo) }));
        setNotice({ tone: "ok", text: `Saved ${result.value ?? 0} active station(s).` });
      }
    });

  const saveRoutes = () =>
    startTransition(async () => {
      setNotice(null);
      const payload: { targetType: "category" | "item" | "combo"; targetId: string; stationId: string }[] = [];
      for (const [targetId, stationId] of Object.entries(routes.category)) {
        if (stationId) payload.push({ targetType: "category", targetId, stationId });
      }
      for (const [targetId, stationId] of Object.entries(routes.item)) {
        if (stationId) payload.push({ targetType: "item", targetId, stationId });
      }
      for (const [targetId, stationId] of Object.entries(routes.combo)) {
        if (stationId) payload.push({ targetType: "combo", targetId, stationId });
      }
      const result = await saveRoutesAction({ outletId, routes: payload });
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      const fresh = await refreshData();
      if (fresh) {
        setRoutes(routeDrafts(fresh));
        setNotice({ tone: "ok", text: `Saved ${result.value ?? 0} route(s).` });
      }
    });

  const stationSelect = (
    value: string,
    onChange: (next: string) => void,
    label: string,
    emptyLabel: string,
  ) => (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-12 min-w-56 rounded-lg border border-border bg-card px-3 text-base"
    >
      <option value="">{emptyLabel}</option>
      {data.stations.map((station) => (
        <option key={station.id} value={station.id}>
          {station.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">Kitchen routing</h2>
          <p className="text-sm text-muted-foreground">
            {outletName} · which station cooks what. Changes apply to orders sent from now on.
          </p>
        </div>
        <Link
          href={backHref}
          className="inline-flex h-12 items-center gap-2 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
        >
          <ArrowLeft className="size-5" aria-hidden />
          Back to board
        </Link>
      </div>

      {notice ? (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={cn(
            "rounded-xl border p-3 text-sm",
            notice.tone === "error"
              ? "border-red-500 bg-red-50 text-red-900"
              : "border-emerald-500 bg-emerald-50 text-emerald-900",
          )}
        >
          {notice.text}
        </div>
      ) : null}

      <section aria-labelledby="stations-heading" className="space-y-3 rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 id="stations-heading" className="text-lg font-semibold">
              Stations
            </h3>
            <p className="text-sm text-muted-foreground">
              Up to {MAX_STATIONS}. Removing a station hides it from routing; its history is kept.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-12"
            onClick={addStation}
            disabled={stations.length >= MAX_STATIONS || pending}
          >
            <Plus className="size-5" aria-hidden />
            Add station
          </Button>
        </div>

        {stations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            No active stations. Items will show under Unrouted until you add one.
          </p>
        ) : null}

        <ul className="space-y-2">
          {stations.map((station) => (
            <li key={station.key} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <Input
                aria-label="Station name"
                placeholder="Station name, e.g. Hot kitchen"
                maxLength={60}
                value={station.name}
                onChange={(e) => updateStation(station.key, { name: e.target.value })}
                className="h-12"
              />
              <Input
                aria-label="Station description"
                placeholder="Description (optional)"
                maxLength={200}
                value={station.description}
                onChange={(e) => updateStation(station.key, { description: e.target.value })}
                className="h-12"
              />
              <Button
                type="button"
                variant="ghost"
                className="h-12"
                onClick={() => removeStation(station.key)}
                aria-label={`Remove ${station.name || "station"}`}
              >
                <Trash2 className="size-5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>

        <div className="flex justify-end">
          <Button type="button" className="h-12" onClick={saveStations} disabled={pending}>
            {pending ? "Saving…" : "Save stations"}
          </Button>
        </div>
      </section>

      <section aria-labelledby="routes-heading" className="space-y-4 rounded-2xl border border-border bg-card p-5">
        <div>
          <h3 id="routes-heading" className="text-lg font-semibold">
            Routing
          </h3>
          <p className="text-sm text-muted-foreground">
            An item route overrides its category. Anything without a route shows under Unrouted on the board.
          </p>
        </div>

        {data.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add menu categories first, then route them here.</p>
        ) : null}

        {data.categories.map((category) => {
          const items = itemsByCategory.get(category.id) ?? [];
          return (
            <div key={category.id} className="space-y-2 rounded-xl border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-semibold">{category.name}</p>
                {stationSelect(
                  routes.category[category.id] ?? "",
                  (next) => setRoutes((prev) => ({ ...prev, category: { ...prev.category, [category.id]: next } })),
                  `Route for category ${category.name}`,
                  "Unrouted",
                )}
              </div>
              {items.map((item) => (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-2">
                  <p className="pl-4 text-sm">{item.name}</p>
                  {stationSelect(
                    routes.item[item.id] ?? "",
                    (next) => setRoutes((prev) => ({ ...prev, item: { ...prev.item, [item.id]: next } })),
                    `Route for item ${item.name}`,
                    "Follow category",
                  )}
                </div>
              ))}
            </div>
          );
        })}

        {data.combos.length > 0 ? (
          <div className="space-y-2 rounded-xl border border-border p-4">
            <p className="font-semibold">Combos</p>
            {data.combos.map((combo) => (
              <div key={combo.id} className="flex flex-wrap items-center justify-between gap-3">
                <p className="pl-4 text-sm">{combo.name}</p>
                {stationSelect(
                  routes.combo[combo.id] ?? "",
                  (next) => setRoutes((prev) => ({ ...prev, combo: { ...prev.combo, [combo.id]: next } })),
                  `Route for combo ${combo.name}`,
                  "Unrouted",
                )}
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="button" className="h-12" onClick={saveRoutes} disabled={pending}>
            {pending ? "Saving…" : "Save routing"}
          </Button>
        </div>
      </section>
    </div>
  );
}
