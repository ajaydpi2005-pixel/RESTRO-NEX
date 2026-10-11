"use client";

import * as React from "react";
import { parseDraft, serializeDraft, type WaiterLine } from "@/modules/waiter/cart";

/**
 * Phase 12 — the unsent cart for one table, kept in this device's localStorage so
 * a reload doesn't lose it. Read through useSyncExternalStore: the server snapshot
 * is empty, so there is no hydration mismatch, and no state is set inside an effect.
 */

const CHANGE_EVENT = "restronex:waiter-draft";

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useDraftLines(storageKey: string): [WaiterLine[], (next: WaiterLine[]) => void] {
  const subscribeFor = React.useCallback((onChange: () => void) => subscribe(onChange), []);
  const raw = React.useSyncExternalStore(
    subscribeFor,
    () => window.localStorage.getItem(storageKey),
    () => null,
  );
  const lines = React.useMemo(() => parseDraft(raw), [raw]);

  const setLines = React.useCallback(
    (next: WaiterLine[]) => {
      if (next.length === 0) window.localStorage.removeItem(storageKey);
      else window.localStorage.setItem(storageKey, serializeDraft(next));
      window.dispatchEvent(new Event(CHANGE_EVENT));
    },
    [storageKey],
  );

  return [lines, setLines];
}
