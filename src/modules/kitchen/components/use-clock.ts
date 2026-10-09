"use client";

import { useSyncExternalStore } from "react";

/**
 * Phase 11 — a shared one-second clock for timers.
 *
 * Returns null on the server and during hydration, so timer text never causes
 * a hydration mismatch; the first client render fills it in.
 */

function subscribe(onTick: () => void): () => void {
  const id = window.setInterval(onTick, 1000);
  return () => window.clearInterval(id);
}

function getSnapshot(): number {
  return Math.floor(Date.now() / 1000) * 1000;
}

function getServerSnapshot(): null {
  return null;
}

export function useClock(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
