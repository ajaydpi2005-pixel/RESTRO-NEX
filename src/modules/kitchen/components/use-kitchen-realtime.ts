"use client";

import { useEffect, useRef } from "react";
import type { RealtimePostgresChangesPayload, RealtimeChannel } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";

/**
 * Phase 11 — realtime subscription for one outlet's board.
 *
 * Uses the browser client (anon key + the signed-in session), so Postgres RLS
 * decides what each screen receives. The outlet filter narrows traffic; RLS is
 * still the boundary.
 */

export type ChangePayload = RealtimePostgresChangesPayload<Record<string, unknown>>;
export type ConnectionStatus = "connecting" | "live" | "reconnecting";

interface Handlers {
  onItemChange: (payload: ChangePayload) => void;
  onEventChange: (payload: ChangePayload) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export function useKitchenRealtime(outletId: string, handlers: Handlers): void {
  const latest = useRef(handlers);

  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const supabase = createClient();
    const channel: RealtimeChannel = supabase
      .channel(`kitchen-board:${outletId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kitchen_items", filter: `outlet_id=eq.${outletId}` },
        (payload) => latest.current.onItemChange(payload),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "kitchen_events", filter: `outlet_id=eq.${outletId}` },
        (payload) => latest.current.onEventChange(payload),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") latest.current.onStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") latest.current.onStatus("reconnecting");
        else if (status === "CLOSED") latest.current.onStatus("reconnecting");
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [outletId]);
}
