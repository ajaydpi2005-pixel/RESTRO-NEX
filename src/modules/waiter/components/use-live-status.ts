"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/**
 * Phase 12 — live status for the waiter screens.
 *
 * The waiter app re-reads its server data on an interval (router.refresh keeps
 * client state such as an in-progress cart). Realtime is deliberately not used
 * here: the waiter has no kitchen.view, and item progress is read through
 * orders/order_items, which the polling path already covers.
 */

export function useLiveRefresh(intervalMs: number): void {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [router, intervalMs]);
}

/** Vibrates when the number of ready items goes up (the kitchen finished something). */
export function useReadyAlert(readyCount: number): void {
  const previous = useRef(readyCount);
  useEffect(() => {
    if (readyCount > previous.current && typeof navigator !== "undefined") {
      navigator.vibrate?.([160, 80, 160]);
    }
    previous.current = readyCount;
  }, [readyCount]);
}
