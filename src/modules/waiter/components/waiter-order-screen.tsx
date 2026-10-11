"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, BellRing, Loader2, Receipt, Send, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { minorToDisplay } from "@/modules/menu/schemas";
import type { PosCombo, PosCategory, PosProduct } from "@/modules/orders/queries";
import {
  WAITER_NOTE_MAX,
  WAITER_ORDER_NOTE_MAX,
  draftStorageKey,
  estimateTotalMinor,
  itemCount,
  removeLine,
  setLineNote,
  setLineQuantity,
  toSubmissionItems,
  type WaiterLine,
} from "@/modules/waiter/cart";
import {
  KITCHEN_ITEM_LABEL,
  ORDER_STATUS_LABEL,
  isPosDraftState,
  isSentOrderState,
  kitchenTone,
  readyItemCount,
  type KitchenTone,
} from "@/modules/waiter/status";
import { requestBillAction, submitWaiterOrderAction } from "@/modules/waiter/actions";
import type { WaiterOrderView } from "@/modules/waiter/queries";
import { WaiterProductSheet, Stepper, type SheetTarget } from "@/modules/waiter/components/product-sheet";
import { useLiveRefresh, useReadyAlert } from "@/modules/waiter/components/use-live-status";
import { useDraftLines } from "@/modules/waiter/components/use-draft-lines";

interface Props {
  businessId: string;
  outlet: { id: string; name: string };
  table: { id: string; label: string };
  menu: { categories: PosCategory[]; products: PosProduct[]; combos: PosCombo[] };
  order: WaiterOrderView | null;
}

const money = (minor: number) => `₹${minorToDisplay(minor)}`;

const TONE_CLASS: Record<KitchenTone, string> = {
  muted: "bg-muted text-muted-foreground",
  info: "bg-sky-500/15 text-sky-800 dark:text-sky-300",
  progress: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  ready: "bg-emerald-600 text-white",
  done: "bg-muted text-muted-foreground",
  cancelled: "bg-rose-500/15 text-rose-800 line-through dark:text-rose-300",
};

const COMBOS_TAB = "__combos";

/**
 * Phase 12 — the waiter's table screen.
 *
 *  - No order yet: build a draft on the device (saved locally), then send it.
 *  - Sent order: see every line's kitchen progress, add a further round, and
 *    request the bill. Sent lines are never edited from here.
 *  - Open or held at the POS: read-only; the cashier finishes it at the POS.
 *
 * Money on this screen is an estimate; the server prices the order when sent.
 */
export function WaiterOrderScreen({ businessId, outlet, table, menu, order }: Props) {
  const router = useRouter();
  useLiveRefresh(4000);
  const readyCount = order ? readyItemCount(order.items) : 0;
  useReadyAlert(readyCount);

  const posDraft = Boolean(order && isPosDraftState(order.status));
  const sent = Boolean(order && isSentOrderState(order.status));

  // ── local draft ──────────────────────────────────────────────────────────
  const storageKey = draftStorageKey(outlet.id, table.id);
  const [lines, setLines] = useDraftLines(storageKey);

  const [orderNote, setOrderNote] = React.useState("");
  const [category, setCategory] = React.useState<string | null>(null);
  const [sheetTarget, setSheetTarget] = React.useState<SheetTarget | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, startTransition] = React.useTransition();

  // A reference is reused only while the payload is unchanged, so a retry after a
  // lost response is idempotent, but an edited cart can never be swallowed by an old one.
  const attempt = React.useRef<{ fingerprint: string; ref: string } | null>(null);
  const newKey = React.useCallback(() => crypto.randomUUID(), []);

  const addLine = (line: WaiterLine) => {
    setLines([...lines, line]);
    setNotice(null);
    setError(null);
  };

  const newRound = lines.length;
  const estimate = estimateTotalMinor(lines);

  const send = () => {
    setError(null);
    setNotice(null);
    const body = {
      outletId: outlet.id,
      tableId: sent ? null : table.id,
      orderId: sent && order ? order.id : null,
      notes: sent ? null : orderNote.trim() || null,
      send: true,
      items: toSubmissionItems(lines),
    };
    const fingerprint = JSON.stringify(body);
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) {
      attempt.current = { fingerprint, ref: crypto.randomUUID() };
    }
    const payload = JSON.stringify({ ...body, clientRef: attempt.current.ref });

    startTransition(async () => {
      const result = await submitWaiterOrderAction(businessId, payload);
      if (!result.ok) {
        setError(result.error ?? "Could not send. Try again.");
        return;
      }
      attempt.current = null;
      setLines([]);
      setOrderNote("");
      setReviewOpen(false);
      setNotice(sent ? "Added to the kitchen." : "Sent to the kitchen.");
      router.refresh();
    });
  };

  const requestBill = () => {
    if (!order) return;
    setError(null);
    startTransition(async () => {
      const result = await requestBillAction(businessId, order.id);
      if (!result.ok) {
        setError(result.error ?? "Could not request the bill.");
        return;
      }
      setNotice("Bill requested. The cashier can see it on the floor.");
      router.refresh();
    });
  };

  // ── menu filter ──────────────────────────────────────────────────────────
  const hasCombos = menu.combos.length > 0;
  const tabs = menu.categories.filter((c) => menu.products.some((p) => p.categoryId === c.id));
  const activeTab = category ?? tabs[0]?.id ?? (hasCombos ? COMBOS_TAB : null);
  const visibleProducts =
    activeTab && activeTab !== COMBOS_TAB ? menu.products.filter((p) => p.categoryId === activeTab) : [];

  const sentItems = order?.items ?? [];
  const billRequestedAt = order?.billRequestedAt ?? null;

  return (
    <div className="flex min-h-dvh flex-col bg-background pb-32">
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <Link
          href={`/waiter?business=${businessId}&outlet=${outlet.id}`}
          className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border"
          aria-label="Back to tables"
        >
          <ArrowLeft className="size-6" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-2xl font-semibold">{table.label}</p>
          <p className="truncate text-sm text-muted-foreground">
            {outlet.name}
            {order ? ` · Order #${order.orderNumber} · ${ORDER_STATUS_LABEL[order.status] ?? order.status}` : " · New order"}
          </p>
        </div>
        {billRequestedAt ? (
          <span className="rounded-full bg-rose-500/15 px-3 py-1.5 text-sm font-semibold text-rose-800 dark:text-rose-300">
            Bill requested
          </span>
        ) : null}
      </header>

      <main className="flex flex-1 flex-col gap-5 p-4">
        {notice ? (
          <p role="status" className="rounded-xl border border-emerald-600/40 bg-emerald-500/10 px-4 py-3 text-base text-emerald-800 dark:text-emerald-300">
            {notice}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-base text-rose-800 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        {posDraft && order ? (
          <section className="flex flex-col gap-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 p-4">
            <p className="text-base font-semibold">This order is still open at the POS.</p>
            <p className="text-sm text-muted-foreground">
              Waiters can&apos;t change POS drafts. Finish it at the POS, then return here to take more orders.
            </p>
            <SentLines items={sentItems} />
          </section>
        ) : null}

        {sent && order ? (
          <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-xl font-semibold">Sent to kitchen</h2>
              {readyCount > 0 ? (
                <span className="flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white">
                  <BellRing className="size-4" aria-hidden />
                  {readyCount} ready
                </span>
              ) : null}
            </div>
            <SentLines items={sentItems} />
            <div className="flex items-center justify-between border-t pt-3 text-base">
              <span className="text-muted-foreground">Running total</span>
              <span className="font-semibold tabular-nums">{money(order.totalMinor)}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="h-14 w-full text-base"
              disabled={busy || Boolean(billRequestedAt)}
              onClick={requestBill}
            >
              <Receipt className="size-5" />
              {billRequestedAt ? "Bill requested" : "Request bill"}
            </Button>
          </section>
        ) : null}

        {!posDraft ? (
          <section className="flex flex-col gap-3">
            <h2 className="font-display text-xl font-semibold">
              {sent ? "Add to this order" : "Menu"}
            </h2>

            {tabs.length > 0 || hasCombos ? (
              <nav aria-label="Categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
                {tabs.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCategory(c.id)}
                    aria-pressed={activeTab === c.id}
                    className={cn(
                      "shrink-0 rounded-full border px-4 py-2.5 text-base font-medium",
                      activeTab === c.id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
                    )}
                  >
                    {c.name}
                  </button>
                ))}
                {hasCombos ? (
                  <button
                    type="button"
                    onClick={() => setCategory(COMBOS_TAB)}
                    aria-pressed={activeTab === COMBOS_TAB}
                    className={cn(
                      "shrink-0 rounded-full border px-4 py-2.5 text-base font-medium",
                      activeTab === COMBOS_TAB ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background",
                    )}
                  >
                    Combos
                  </button>
                ) : null}
              </nav>
            ) : (
              <p className="text-base text-muted-foreground">No menu items are set up for this outlet yet.</p>
            )}

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {activeTab === COMBOS_TAB
                ? menu.combos.map((combo) => (
                    <MenuTile
                      key={combo.id}
                      name={combo.name}
                      price={money(combo.priceMinor)}
                      available={combo.isAvailable}
                      onTap={() => setSheetTarget({ kind: "combo", combo })}
                    />
                  ))
                : visibleProducts.map((product) => {
                    const available = product.isAvailable && product.outletAvailable;
                    const from = product.variants.length > 0
                      ? Math.min(...product.variants.map((v) => v.priceMinor))
                      : product.effectivePriceMinor;
                    return (
                      <MenuTile
                        key={product.id}
                        name={product.name}
                        price={`${product.variants.length > 0 ? "from " : ""}${money(from)}`}
                        hint={product.modifierGroups.length > 0 || product.variants.length > 0 ? "Options" : undefined}
                        available={available}
                        onTap={() => setSheetTarget({ kind: "product", product })}
                      />
                    );
                  })}
            </div>
          </section>
        ) : null}
      </main>

      {!posDraft ? (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <div className="min-w-0 flex-1">
              {newRound > 0 ? (
                <>
                  <p className="text-base font-semibold">
                    {itemCount(lines)} item{itemCount(lines) === 1 ? "" : "s"} to send
                  </p>
                  <p className="text-sm text-muted-foreground">Estimate {money(estimate)} before tax</p>
                </>
              ) : (
                <p className="text-base text-muted-foreground">
                  {sent ? "Tap items to add another round." : "Tap items to start the order."}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="lg"
              className="h-14 min-w-36 text-base"
              disabled={newRound === 0}
              onClick={() => setReviewOpen(true)}
            >
              Review
            </Button>
          </div>
        </div>
      ) : null}

      <WaiterProductSheet
        target={sheetTarget}
        onClose={() => setSheetTarget(null)}
        onAdd={addLine}
        newKey={newKey}
      />

      <Sheet open={reviewOpen} onOpenChange={setReviewOpen}>
        <SheetContent side="bottom" className="max-h-[92dvh] overflow-y-auto rounded-t-2xl p-0">
          <SheetHeader className="px-5 pt-5">
            <SheetTitle className="font-display text-2xl">
              {sent ? "Send another round" : "Review order"}
            </SheetTitle>
            <SheetDescription className="text-base">
              {sent
                ? "Only these new items are sent. Items already in the kitchen stay as they are."
                : `${table.label} · ${outlet.name}`}
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 px-5 py-4">
            {lines.map((line) => (
              <ReviewLine
                key={line.key}
                line={line}
                onQuantity={(q) => setLines(setLineQuantity(lines, line.key, q))}
                onRemove={() => setLines(removeLine(lines, line.key))}
                onNote={(note) => setLines(setLineNote(lines, line.key, note))}
              />
            ))}

            {!sent ? (
              <label className="flex flex-col gap-2 pt-2">
                <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Order note</span>
                <textarea
                  value={orderNote}
                  maxLength={WAITER_ORDER_NOTE_MAX}
                  onChange={(e) => setOrderNote(e.target.value)}
                  rows={2}
                  placeholder="Birthday, window seat, allergies…"
                  className="rounded-xl border border-input bg-background px-4 py-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
            ) : null}

            <p className="pt-2 text-sm text-muted-foreground">
              Estimate {money(estimate)} before tax. The final total is calculated when the order is sent.
            </p>
            {error ? (
              <p role="alert" className="rounded-xl border border-rose-500/50 bg-rose-500/10 px-4 py-3 text-base text-rose-800 dark:text-rose-300">
                {error}
              </p>
            ) : null}
          </div>

          <div className="sticky bottom-0 border-t bg-background px-5 py-4">
            <Button
              type="button"
              size="lg"
              className="h-14 w-full text-base"
              disabled={busy || lines.length === 0}
              onClick={send}
            >
              {busy ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}
              {sent
                ? `Send ${itemCount(lines)} more to kitchen`
                : `Send ${itemCount(lines)} to kitchen`}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function SentLines({ items }: { items: WaiterOrderView["items"] }) {
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No items yet.</p>;
  return (
    <ul className="flex flex-col divide-y">
      {items.map((item) => (
        <li key={item.id} className="flex items-start justify-between gap-3 py-3">
          <div className="min-w-0">
            <p className={cn("text-base font-medium", item.kitchenStatus === "cancelled" && "line-through opacity-60")}>
              {item.quantity} × {item.name}
            </p>
            {item.modifiers.length > 0 ? (
              <p className="text-sm text-muted-foreground">{item.modifiers.join(", ")}</p>
            ) : null}
            {item.itemNotes ? <p className="text-sm italic text-muted-foreground">“{item.itemNotes}”</p> : null}
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-3 py-1 text-sm font-semibold",
              TONE_CLASS[kitchenTone(item.kitchenStatus)],
            )}
          >
            {KITCHEN_ITEM_LABEL[item.kitchenStatus] ?? item.kitchenStatus}
          </span>
        </li>
      ))}
    </ul>
  );
}

function MenuTile({
  name,
  price,
  hint,
  available,
  onTap,
}: {
  name: string;
  price: string;
  hint?: string;
  available: boolean;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={onTap}
      className={cn(
        "flex min-h-24 flex-col justify-between rounded-2xl border-2 border-border bg-card p-3 text-left transition-colors active:scale-[0.98]",
        !available && "opacity-40",
      )}
    >
      <span className="text-base font-semibold leading-tight">{name}</span>
      <span className="mt-2 flex items-center justify-between gap-2 text-sm">
        <span className="font-semibold tabular-nums">{price}</span>
        {!available ? (
          <span className="text-muted-foreground">Unavailable</span>
        ) : hint ? (
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </span>
    </button>
  );
}

function ReviewLine({
  line,
  onQuantity,
  onRemove,
  onNote,
}: {
  line: WaiterLine;
  onQuantity: (q: number) => void;
  onRemove: () => void;
  onNote: (note: string) => void;
}) {
  const [noteOpen, setNoteOpen] = React.useState(Boolean(line.itemNotes));
  return (
    <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-base font-semibold">{line.name}</p>
          {line.modifiers.length > 0 ? (
            <p className="text-sm text-muted-foreground">{line.modifiers.map((m) => m.name).join(", ")}</p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          className="size-12 shrink-0 rounded-xl text-rose-600"
          aria-label={`Remove ${line.name}`}
          onClick={onRemove}
        >
          <Trash2 className="size-5" />
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Stepper value={line.quantity} onChange={onQuantity} min={1} max={99} label={`Quantity of ${line.name}`} />
        <button
          type="button"
          onClick={() => setNoteOpen((open) => !open)}
          className="min-h-12 rounded-xl px-3 text-base font-medium text-primary underline-offset-4 hover:underline"
        >
          {noteOpen ? "Hide note" : line.itemNotes ? "Edit note" : "Add note"}
        </button>
      </div>
      {noteOpen ? (
        <input
          value={line.itemNotes ?? ""}
          maxLength={WAITER_NOTE_MAX}
          onChange={(e) => onNote(e.target.value)}
          placeholder="No onion, extra spicy…"
          aria-label={`Note for ${line.name}`}
          className="min-h-14 rounded-xl border border-input bg-background px-4 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      ) : null}
    </div>
  );
}
