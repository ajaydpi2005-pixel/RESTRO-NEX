"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Coffee,
  Loader2,
  Minus,
  PauseCircle,
  Play,
  Plus,
  Search,
  Send,
  Trash2,
  UtensilsCrossed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { minorToDisplay } from "@/modules/menu/schemas";
import { computeOrderTotals } from "@/modules/orders/pricing";
import { savePosOrder, transitionOrder } from "@/modules/orders/actions";
import type {
  HeldOrderSummary,
  PosCategory,
  PosCombo,
  PosProduct,
  PosTable,
} from "@/modules/orders/queries";
import { ORDER_TYPE_LABELS, type OrderType } from "@/modules/orders/state";
import { cn } from "@/lib/utils";

// ── prop types (all serialised by the server page) ─────────────────────────

export interface ResumeOrderData {
  orderId: string;
  clientRef: string;
  orderType: string;
  status: string;
  tableId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  notes: string | null;
  discount: { type: "none" | "percent" | "flat"; value: number };
  charges: { name: string; amountMinor: number }[];
  items: {
    itemType: "product" | "combo";
    productId: string | null;
    comboId: string | null;
    variantId: string | null;
    quantity: number;
    itemNotes: string | null;
    modifiers: { modifierId: string; quantity: number }[];
  }[];
}

export interface PosTerminalProps {
  businessId: string;
  outletId: string;
  queryBase: string;
  categories: PosCategory[];
  products: PosProduct[];
  combos: PosCombo[];
  tables: PosTable[];
  held: HeldOrderSummary[];
  businessTaxPct: number;
  canManage: boolean;
  canDiscount: boolean;
  resume: ResumeOrderData | null;
}

interface CartLine {
  key: string;
  itemType: "product" | "combo";
  productId: string | null;
  comboId: string | null;
  variantId: string | null;
  name: string;
  unitPriceMinor: number;
  quantity: number;
  itemNotes: string;
  taxPct: number;
  modifiers: { modifierId: string; name: string; priceMinor: number; quantity: number }[];
}

interface ConfigDraft {
  product: PosProduct;
  lineKey: string | null;
  variantId: string | null;
  modifierQty: Record<string, number>;
  quantity: number;
  itemNotes: string;
}

interface ChargeRow {
  id: string;
  name: string;
  amountText: string;
}

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

function moneyInputToMinor(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number.parseFloat(trimmed) * 100);
}

const amount = (minor: number) => `₹${minorToDisplay(minor)}`;

export function PosTerminal(props: PosTerminalProps) {
  const router = useRouter();
  const {
    businessId,
    outletId,
    queryBase,
    categories,
    products,
    combos,
    tables,
    held,
    businessTaxPct,
    canManage,
    canDiscount,
    resume,
  } = props;

  // ── cart + order form state ──────────────────────────────────────────────
  const [lines, setLines] = React.useState<CartLine[]>(() =>
    resume ? rebuildLines(resume, products, combos, businessTaxPct) : [],
  );
  const [orderId, setOrderId] = React.useState<string | null>(resume?.orderId ?? null);
  const [clientRef, setClientRef] = React.useState<string>(() => resume?.clientRef ?? newId());
  const [orderType, setOrderType] = React.useState<OrderType>(() => {
    if (resume) return (["dine_in", "takeaway", "delivery"].includes(resume.orderType)
      ? resume.orderType
      : "takeaway") as OrderType;
    return tables.length > 0 ? "dine_in" : "takeaway";
  });
  const [tableId, setTableId] = React.useState<string>(resume?.tableId ?? "");
  const [customerName, setCustomerName] = React.useState(resume?.customerName ?? "");
  const [customerPhone, setCustomerPhone] = React.useState(resume?.customerPhone ?? "");
  const [deliveryAddress, setDeliveryAddress] = React.useState(resume?.deliveryAddress ?? "");
  const [orderNotes, setOrderNotes] = React.useState(resume?.notes ?? "");
  const [discountType, setDiscountType] = React.useState<"none" | "percent" | "flat">(
    resume?.discount.type ?? "none",
  );
  const [discountValueText, setDiscountValueText] = React.useState(
    resume && resume.discount.type !== "none" ? String(resume.discount.value) : "",
  );
  const [charges, setCharges] = React.useState<ChargeRow[]>(() =>
    (resume?.charges ?? []).map((c) => ({
      id: newId(),
      name: c.name,
      amountText: minorToDisplay(c.amountMinor),
    })),
  );

  // ── browsing state ───────────────────────────────────────────────────────
  const [search, setSearch] = React.useState("");
  const [activeChip, setActiveChip] = React.useState<string>("all");
  const [config, setConfig] = React.useState<ConfigDraft | null>(null);

  const [busy, setBusy] = React.useState<null | "hold" | "place">(null);
  const [banner, setBanner] = React.useState<{ kind: "error" | "success"; text: string } | null>(
    resume ? { kind: "success", text: `Resumed order ${resume.orderId.slice(0, 8)}… — edit and place it.` } : null,
  );

  // ── derived data ─────────────────────────────────────────────────────────
  const childToParent = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) if (c.parentId) map.set(c.id, c.parentId);
    return map;
  }, [categories]);
  const rootCategories = categories.filter((c) => !c.parentId);

  const visibleProducts = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeChip === "combos") return false;
      if (activeChip !== "all") {
        const parent = childToParent.get(p.categoryId);
        if (p.categoryId !== activeChip && parent !== activeChip) return false;
      }
      return !q || p.name.toLowerCase().includes(q);
    });
  }, [products, search, activeChip, childToParent]);

  const visibleCombos = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (activeChip !== "all" && activeChip !== "combos") return [];
    return combos.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [combos, search, activeChip]);

  const totals = React.useMemo(() => {
    const discountValue =
      discountType === "none"
        ? 0
        : Math.max(0, Math.round(Number.parseFloat(discountValueText || "0") || 0));
    return computeOrderTotals(
      lines.map((l) => ({
        unitPriceMinor: l.unitPriceMinor,
        modifiersMinor: l.modifiers.reduce((s, m) => s + m.priceMinor * m.quantity, 0),
        quantity: l.quantity,
        taxPct: l.taxPct,
      })),
      { type: discountType, value: discountValue },
      charges
        .map((c) => moneyInputToMinor(c.amountText) ?? 0)
        .filter((v) => v > 0),
    );
  }, [lines, discountType, discountValueText, charges]);

  // ── cart operations ──────────────────────────────────────────────────────
  function addProductLine(product: PosProduct, variantId: string | null, modifierQty: Record<string, number>, quantity: number, itemNotes: string, replaceKey?: string) {
    const variant = product.variants.find((v) => v.id === variantId) ?? null;
    const modifiers = product.modifierGroups
      .flatMap((g) => g.modifiers)
      .filter((m) => (modifierQty[m.id] ?? 0) > 0)
      .map((m) => ({
        modifierId: m.id,
        name: m.name,
        priceMinor: m.priceMinor,
        quantity: modifierQty[m.id] ?? 0,
      }));
    const unitPriceMinor = variant ? variant.priceMinor : product.effectivePriceMinor;
    const name = variant ? `${product.name} (${variant.name})` : product.name;
    const line: CartLine = {
      key: replaceKey ?? newId(),
      itemType: "product",
      productId: product.id,
      comboId: null,
      variantId,
      name,
      unitPriceMinor,
      quantity,
      itemNotes,
      taxPct: product.taxRatePct ?? businessTaxPct,
      modifiers,
    };
    // merge only bare lines (no variant/modifiers/notes)
    if (!variant && modifiers.length === 0 && !itemNotes) {
      const existing = lines.find(
        (l) => !replaceKey && l.itemType === "product" && l.productId === product.id && !l.variantId && l.modifiers.length === 0 && !l.itemNotes,
      );
      if (existing) {
        setLines((prev) =>
          prev.map((l) => (l.key === existing.key ? { ...l, quantity: Math.min(99, l.quantity + quantity) } : l)),
        );
        return;
      }
    }
    setLines((prev) => (replaceKey ? prev.map((l) => (l.key === replaceKey ? line : l)) : [...prev, line]));
  }

  function addComboLine(combo: PosCombo) {
    const existing = lines.find((l) => l.itemType === "combo" && l.comboId === combo.id);
    if (existing) {
      setLines((prev) =>
        prev.map((l) => (l.key === existing.key ? { ...l, quantity: Math.min(99, l.quantity + 1) } : l)),
      );
      return;
    }
    setLines((prev) => [
      ...prev,
      {
        key: newId(),
        itemType: "combo",
        productId: null,
        comboId: combo.id,
        variantId: null,
        name: combo.name,
        unitPriceMinor: combo.priceMinor,
        quantity: 1,
        itemNotes: "",
        taxPct: 0,
        modifiers: [],
      },
    ]);
  }

  function tapProduct(product: PosProduct) {
    if (!product.outletAvailable) return;
    if (product.variants.length > 0 || product.modifierGroups.length > 0) {
      setConfig({
        product,
        lineKey: null,
        variantId: product.variants.find((v) => v.isAvailable)?.id ?? null,
        modifierQty: {},
        quantity: 1,
        itemNotes: "",
      });
    } else {
      addProductLine(product, null, {}, 1, "");
    }
  }

  function changeQty(key: string, delta: number) {
    setLines((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0),
    );
  }

  function resetCart(message?: { kind: "error" | "success"; text: string }) {
    setLines([]);
    setOrderId(null);
    setClientRef(newId());
    setTableId("");
    setCustomerName("");
    setCustomerPhone("");
    setDeliveryAddress("");
    setOrderNotes("");
    setDiscountType("none");
    setDiscountValueText("");
    setCharges([]);
    setBanner(message ?? null);
  }

  // ── submission ───────────────────────────────────────────────────────────
  function buildPayload(status: "open" | "held"): Record<string, unknown> {
    return {
      outletId,
      clientRef,
      orderId,
      status,
      orderType,
      tableId: orderType === "dine_in" ? tableId || null : null,
      customerName: customerName.trim() || null,
      customerPhone: customerPhone.trim() || null,
      deliveryAddress: deliveryAddress.trim() || null,
      notes: orderNotes.trim() || null,
      discount: {
        type: canDiscount ? discountType : "none",
        value:
          discountType === "none" || !canDiscount
            ? 0
            : Math.max(0, Math.round(Number.parseFloat(discountValueText || "0") || 0)),
      },
      charges: charges
        .map((c) => ({ name: c.name.trim(), amountMinor: moneyInputToMinor(c.amountText) }))
        .filter((c): c is { name: string; amountMinor: number } =>
          Boolean(c.name) && typeof c.amountMinor === "number" && c.amountMinor > 0,
        ),
      items: lines.map((l) => ({
        itemType: l.itemType,
        productId: l.productId,
        comboId: l.comboId,
        variantId: l.variantId,
        quantity: l.quantity,
        itemNotes: l.itemNotes.trim() || null,
        modifiers: l.modifiers.map((m) => ({ modifierId: m.modifierId, quantity: m.quantity })),
      })),
    };
  }

  function localValidationError(): string | null {
    if (lines.length === 0) return "Add at least one item to the order.";
    if (orderType === "dine_in") {
      if (tables.length === 0) return "This outlet has no tables — set them up in onboarding or pick takeaway.";
      if (!tableId) return "Pick a table for this dine-in order.";
    }
    if (orderType === "delivery") {
      if (!customerPhone.trim()) return "Delivery orders need a phone number.";
      if (!deliveryAddress.trim()) return "Delivery orders need an address.";
    }
    if (discountType === "percent") {
      const v = Number.parseFloat(discountValueText || "0");
      if (Number.isNaN(v) || v < 0 || v > 100) return "Percentage discount must be between 0 and 100.";
    }
    if (discountType === "flat") {
      const minor = moneyInputToMinor(discountValueText);
      if (minor === null || minor < 0) return "Enter the discount as a rupee amount, e.g. 50 or 50.00.";
    }
    for (const c of charges) {
      if (!c.name.trim()) return "Every charge needs a name (or remove it).";
      const minor = moneyInputToMinor(c.amountText);
      if (minor === null) return `Enter “${c.name}” as a rupee amount, e.g. 20.`;
    }
    return null;
  }

  async function submit(kind: "hold" | "place") {
    if (!canManage || busy) return;
    const problem = localValidationError();
    if (problem) {
      setBanner({ kind: "error", text: problem });
      return;
    }
    // flat discounts are capped at the subtotal server-side; warn early
    if (discountType === "flat") {
      const minor = moneyInputToMinor(discountValueText) ?? 0;
      if (minor > totals.subtotalMinor) {
        setBanner({ kind: "error", text: "The flat discount is larger than the subtotal." });
        return;
      }
    }
    setBusy(kind);
    setBanner(null);
    const status: "open" | "held" = kind === "hold" ? "held" : "open";
    const formData = new FormData();
    formData.set("businessId", businessId);
    formData.set("payload", JSON.stringify(buildPayload(status)));

    const result = await savePosOrder(formData);
    if (!result.ok) {
      const fieldMessage = result.fieldErrors
        ? Object.values(result.fieldErrors).flat()[0]
        : undefined;
      setBanner({ kind: "error", text: result.error ?? fieldMessage ?? "Could not save the order." });
      setBusy(null);
      return;
    }

    if (kind === "place" && result.orderId) {
      const transitionData = new FormData();
      transitionData.set("businessId", businessId);
      transitionData.set("orderId", result.orderId);
      transitionData.set("toStatus", "placed");
      const placed = await transitionOrder(transitionData);
      if (!placed.ok) {
        setBanner({
          kind: "error",
          text: `Order was saved but not placed: ${placed.error ?? "try again from the Orders page."}`,
        });
        setOrderId(result.orderId);
        router.refresh();
        setBusy(null);
        return;
      }
      resetCart({ kind: "success", text: "Order placed — it's now in the kitchen queue." });
    } else if (kind === "hold") {
      resetCart({ kind: "success", text: "Order put on hold. Resume it any time from the held strip." });
    }
    router.refresh();
    setBusy(null);
  }

  // ── render ───────────────────────────────────────────────────────────────
  const tableSections = React.useMemo(() => {
    const map = new Map<string, PosTable[]>();
    for (const t of tables) {
      const list = map.get(t.sectionName) ?? [];
      list.push(t);
      map.set(t.sectionName, list);
    }
    return [...map.entries()];
  }, [tables]);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
      {/* ── menu browser ── */}
      <div className="space-y-3">
        {banner ? (
          <div
            role={banner.kind === "error" ? "alert" : "status"}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-sm",
              banner.kind === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-gold/40 bg-gold/10 text-foreground",
            )}
          >
            {banner.text}
          </div>
        ) : null}

        {held.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">On hold</span>
            {held.map((h) => (
              <Link
                key={h.id}
                href={`${queryBase}&order=${h.id}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-3 py-1.5 text-xs font-medium text-foreground hover:bg-gold/20"
              >
                <PauseCircle className="size-3.5 text-gold-deep" aria-hidden />
                #{h.orderNumber}
                {h.tableName ? ` · ${h.tableName}` : ` · ${ORDER_TYPE_LABELS[h.orderType as OrderType] ?? h.orderType}`}
                <span className="text-muted-foreground">{amount(h.totalMinor)}</span>
              </Link>
            ))}
            {orderId ? (
              <Link
                href={queryBase}
                className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                Start a fresh order
              </Link>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search the menu…"
              className="h-10 pl-8"
              aria-label="Search menu items"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <ChipButton active={activeChip === "all"} onClick={() => setActiveChip("all")}>
              All
            </ChipButton>
            {rootCategories.map((c) => (
              <ChipButton key={c.id} active={activeChip === c.id} onClick={() => setActiveChip(c.id)}>
                {c.name}
              </ChipButton>
            ))}
            {combos.length > 0 ? (
              <ChipButton active={activeChip === "combos"} onClick={() => setActiveChip("combos")}>
                Combos
              </ChipButton>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {visibleProducts.map((product) => {
            const sold = !product.outletAvailable;
            return (
              <button
                key={product.id}
                type="button"
                disabled={sold}
                onClick={() => tapProduct(product)}
                className={cn(
                  "flex min-h-24 flex-col items-start justify-between gap-2 rounded-xl border border-border bg-card p-3 text-left transition",
                  sold
                    ? "cursor-not-allowed opacity-45"
                    : "hover:border-gold/60 hover:shadow-sm active:translate-y-px",
                )}
              >
                <div className="flex w-full items-start justify-between gap-1">
                  <span className="line-clamp-2 text-sm leading-tight font-medium">{product.name}</span>
                  <VegDot vegetarian={product.isVegetarian} />
                </div>
                <div className="flex w-full items-center justify-between text-xs">
                  <span className="font-semibold text-gold-deep">{amount(product.effectivePriceMinor)}</span>
                  {product.variants.length > 0 || product.modifierGroups.length > 0 ? (
                    <span className="text-muted-foreground">{sold ? "86'd" : "options"}</span>
                  ) : sold ? (
                    <span className="text-muted-foreground">86&apos;d</span>
                  ) : null}
                </div>
              </button>
            );
          })}
          {visibleCombos.map((combo) => (
            <button
              key={combo.id}
              type="button"
              onClick={() => addComboLine(combo)}
              className="flex min-h-24 flex-col items-start justify-between gap-2 rounded-xl border border-gold/50 bg-card p-3 text-left transition hover:border-gold hover:shadow-sm active:translate-y-px"
            >
              <div className="flex w-full items-start justify-between gap-1">
                <span className="line-clamp-2 text-sm leading-tight font-medium">{combo.name}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-gold/15 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-gold-deep uppercase">
                  <Coffee className="size-3" aria-hidden /> Combo
                </span>
              </div>
              <span className="text-xs font-semibold text-gold-deep">{amount(combo.priceMinor)}</span>
            </button>
          ))}
          {visibleProducts.length === 0 && visibleCombos.length === 0 ? (
            <p className="col-span-full rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              Nothing on the menu matches. Check the search or add products under Menu.
            </p>
          ) : null}
        </div>
      </div>

      {/* ── cart ── */}
      <Card className="flex h-fit flex-col gap-3 p-4 lg:sticky lg:top-4">
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label="Order type">
          {(Object.keys(ORDER_TYPE_LABELS) as OrderType[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={orderType === t}
              onClick={() => setOrderType(t)}
              className={cn(
                "flex h-9 items-center justify-center gap-1 rounded-md text-xs font-medium transition",
                orderType === t ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t === "dine_in" ? <UtensilsCrossed className="size-3.5" aria-hidden /> : null}
              {t === "delivery" ? <Send className="size-3.5" aria-hidden /> : null}
              {ORDER_TYPE_LABELS[t]}
            </button>
          ))}
        </div>

        {orderType === "dine_in" ? (
          <div className="space-y-1">
            <Label htmlFor="pos-table">Table</Label>
            <Select id="pos-table" value={tableId} onChange={(e) => setTableId(e.target.value)} className="h-10">
              <option value="">Select a table…</option>
              {tableSections.map(([section, list]) => (
                <optgroup key={section} label={section}>
                  {list.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} · seats {t.capacity}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="pos-customer">Customer</Label>
            <Input id="pos-customer" value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Name (optional)" className="h-10" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pos-phone">Phone</Label>
            <Input id="pos-phone" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder={orderType === "delivery" ? "Required" : "Optional"} className="h-10" inputMode="tel" />
          </div>
        </div>
        {orderType === "delivery" ? (
          <div className="space-y-1">
            <Label htmlFor="pos-address">Delivery address</Label>
            <Input id="pos-address" value={deliveryAddress} onChange={(e) => setDeliveryAddress(e.target.value)} placeholder="Street, area, city" className="h-10" />
          </div>
        ) : null}

        <Separator />

        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {lines.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Tap menu items to build the order.
            </p>
          ) : (
            lines.map((line) => (
              <div key={line.key} className="rounded-lg border border-border p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{line.name}</p>
                    {line.modifiers.length > 0 ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {line.modifiers.map((m) => (m.quantity > 1 ? `${m.quantity}× ${m.name}` : m.name)).join(", ")}
                      </p>
                    ) : null}
                    {line.itemNotes ? <p className="mt-0.5 text-xs text-gold-deep italic">“{line.itemNotes}”</p> : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                    className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    aria-label={`Remove ${line.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <Button type="button" variant="outline" size="icon-sm" onClick={() => changeQty(line.key, -1)} aria-label="Decrease quantity">
                      <Minus />
                    </Button>
                    <span className="w-8 text-center text-sm font-semibold tabular-nums">{line.quantity}</span>
                    <Button type="button" variant="outline" size="icon-sm" onClick={() => changeQty(line.key, 1)} aria-label="Increase quantity">
                      <Plus />
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    {line.itemType === "product" ? (
                      <button
                        type="button"
                        onClick={() => editLine(line)}
                        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      >
                        Edit
                      </button>
                    ) : null}
                    <span className="text-sm font-semibold tabular-nums">
                      {amount((line.unitPriceMinor + line.modifiers.reduce((s, m) => s + m.priceMinor * m.quantity, 0)) * line.quantity)}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-1">
          <Label htmlFor="pos-notes">Order notes</Label>
          <Input id="pos-notes" value={orderNotes} onChange={(e) => setOrderNotes(e.target.value)} placeholder="e.g. less spicy, birthday candle" className="h-10" />
        </div>

        <Separator />

        {/* discount + charges */}
        <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
          <Label htmlFor="pos-discount-type" className="text-xs">Discount</Label>
          <div className="flex gap-2">
            <Select
              id="pos-discount-type"
              value={discountType}
              disabled={!canDiscount}
              onChange={(e) => setDiscountType(e.target.value as "none" | "percent" | "flat")}
            >
              <option value="none">None</option>
              <option value="percent">Percent %</option>
              <option value="flat">Flat ₹</option>
            </Select>
            {discountType !== "none" ? (
              <Input
                aria-label="Discount value"
                value={discountValueText}
                disabled={!canDiscount}
                onChange={(e) => setDiscountValueText(e.target.value)}
                placeholder={discountType === "percent" ? "10" : "50.00"}
                inputMode="decimal"
              />
            ) : null}
          </div>
        </div>
        {!canDiscount ? (
          <p className="text-xs text-muted-foreground">Your role can&apos;t apply discounts.</p>
        ) : null}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Charges</span>
            {charges.length < 5 ? (
              <button
                type="button"
                onClick={() => setCharges((prev) => [...prev, { id: newId(), name: "", amountText: "" }])}
                className="text-xs text-gold-deep underline-offset-2 hover:underline"
              >
                + Add charge
              </button>
            ) : null}
          </div>
          {charges.map((charge) => (
            <div key={charge.id} className="flex items-center gap-2">
              <Input
                aria-label="Charge name"
                value={charge.name}
                placeholder="e.g. Packing"
                className="h-9 flex-1"
                onChange={(e) =>
                  setCharges((prev) => prev.map((c) => (c.id === charge.id ? { ...c, name: e.target.value } : c)))
                }
              />
              <Input
                aria-label="Charge amount"
                value={charge.amountText}
                placeholder="0.00"
                inputMode="decimal"
                className="h-9 w-24"
                onChange={(e) =>
                  setCharges((prev) =>
                    prev.map((c) => (c.id === charge.id ? { ...c, amountText: e.target.value } : c)),
                  )
                }
              />
              <button
                type="button"
                onClick={() => setCharges((prev) => prev.filter((c) => c.id !== charge.id))}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Remove charge"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
        </div>

        <Separator />

        {/* totals */}
        <div className="space-y-1 text-sm">
          <TotalRow label="Subtotal" value={totals.subtotalMinor} />
          {totals.discountMinor > 0 ? <TotalRow label="Discount" value={-totals.discountMinor} /> : null}
          {totals.taxMinor > 0 ? <TotalRow label={`Tax${businessTaxPct > 0 ? ` (${businessTaxPct}% excl.)` : ""}`} value={totals.taxMinor} /> : null}
          {totals.chargesMinor > 0 ? <TotalRow label="Charges" value={totals.chargesMinor} /> : null}
          <div className="flex items-center justify-between border-t border-border pt-2 text-base font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{amount(totals.totalMinor)}</span>
          </div>
        </div>

        {!canManage ? (
          <p className="text-xs text-muted-foreground">Your role can browse the menu but not take orders.</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-12 text-sm"
              disabled={busy !== null || lines.length === 0}
              onClick={() => void submit("hold")}
            >
              {busy === "hold" ? <Loader2 className="animate-spin" /> : <PauseCircle />}
              Hold
            </Button>
            <Button
              type="button"
              className="h-12 bg-ink text-sm text-parchment hover:bg-ink-soft"
              disabled={busy !== null || lines.length === 0}
              onClick={() => void submit("place")}
            >
              {busy === "place" ? <Loader2 className="animate-spin" /> : <Play />}
              {orderId ? "Save & place" : "Place order"}
            </Button>
          </div>
        )}
      </Card>

      {/* ── item configuration sheet ── */}
      <Sheet open={config !== null} onOpenChange={(open) => !open && setConfig(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto p-5 sm:max-w-md">
          {config ? (
            <ItemConfigurator
              draft={config}
              businessTaxPct={businessTaxPct}
              onChange={setConfig}
              onClose={() => setConfig(null)}
              onConfirm={(d) => {
                addProductLine(d.product, d.variantId, d.modifierQty, d.quantity, d.itemNotes, d.lineKey ?? undefined);
                setConfig(null);
              }}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );

  function editLine(line: CartLine) {
    const product = products.find((p) => p.id === line.productId);
    if (!product) return;
    setConfig({
      product,
      lineKey: line.key,
      variantId: line.variantId,
      modifierQty: Object.fromEntries(line.modifiers.map((m) => [m.modifierId, m.quantity])),
      quantity: line.quantity,
      itemNotes: line.itemNotes,
    });
  }
}

// ── small pieces ────────────────────────────────────────────────────────────

function ChipButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1.5 text-xs font-medium transition",
        active
          ? "border-ink bg-ink text-parchment"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function VegDot({ vegetarian }: { vegetarian: boolean }) {
  return (
    <span
      aria-label={vegetarian ? "Vegetarian" : "Non-vegetarian"}
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded-[3px] border",
        vegetarian ? "border-green-700" : "border-red-700",
      )}
    >
      <span className={cn("size-1.5 rounded-full", vegetarian ? "bg-green-700" : "bg-red-700")} />
    </span>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("tabular-nums", value < 0 && "text-green-700")}>
        {value < 0 ? `−${amount(-value)}` : amount(value)}
      </span>
    </div>
  );
}

function ItemConfigurator({
  draft,
  businessTaxPct,
  onChange,
  onClose,
  onConfirm,
}: {
  draft: ConfigDraft;
  businessTaxPct: number;
  onChange: (d: ConfigDraft) => void;
  onClose: () => void;
  onConfirm: (d: ConfigDraft) => void;
}) {
  const { product } = draft;
  const variant = product.variants.find((v) => v.id === draft.variantId) ?? null;
  const unitPrice = variant ? variant.priceMinor : product.effectivePriceMinor;
  const modifierTotal = product.modifierGroups
    .flatMap((g) => g.modifiers)
    .reduce((sum, m) => sum + m.priceMinor * (draft.modifierQty[m.id] ?? 0), 0);
  const lineTotal = (unitPrice + modifierTotal) * draft.quantity;

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2 text-left">
          {product.name}
          <VegDot vegetarian={product.isVegetarian} />
        </SheetTitle>
        <p className="text-left text-xs text-muted-foreground">
          {draft.lineKey ? "Editing this line" : "Building a new line"} · tax{" "}
          {(product.taxRatePct ?? businessTaxPct).toFixed(2)}% excl.
        </p>
      </SheetHeader>

      {product.variants.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Pick a size</p>
          <div className="grid gap-1.5">
            {product.variants.map((v) => (
              <button
                key={v.id}
                type="button"
                disabled={!v.isAvailable}
                onClick={() => onChange({ ...draft, variantId: v.id })}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm transition",
                  draft.variantId === v.id
                    ? "border-gold bg-gold/10 font-medium"
                    : "border-border hover:border-gold/50",
                  !v.isAvailable && "cursor-not-allowed opacity-40",
                )}
              >
                <span>{v.name}</span>
                <span className="tabular-nums">{amount(v.priceMinor)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {product.modifierGroups.map((group) => {
        const selectedCount = group.modifiers.filter((m) => (draft.modifierQty[m.id] ?? 0) > 0).length;
        const atMax = group.maxSelected !== null && selectedCount >= group.maxSelected;
        return (
          <div key={group.id} className="space-y-2">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{group.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {group.minSelected > 0 ? `min ${group.minSelected}` : "optional"}
                {group.maxSelected !== null ? ` · max ${group.maxSelected}` : ""}
              </p>
            </div>
            <div className="grid gap-1.5">
              {group.modifiers.map((m) => {
                const qty = draft.modifierQty[m.id] ?? 0;
                return (
                  <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-sm">{m.name}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {m.priceMinor > 0 ? `+${amount(m.priceMinor)}` : "free"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Remove one ${m.name}`}
                        disabled={qty === 0}
                        onClick={() => onChange({ ...draft, modifierQty: { ...draft.modifierQty, [m.id]: Math.max(0, qty - 1) } })}
                      >
                        <Minus />
                      </Button>
                      <span className="w-6 text-center text-sm tabular-nums">{qty}</span>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon-sm"
                        aria-label={`Add one ${m.name}`}
                        disabled={(qty > 0 ? false : atMax) || qty >= 20}
                        onClick={() => onChange({ ...draft, modifierQty: { ...draft.modifierQty, [m.id]: qty + 1 } })}
                      >
                        <Plus />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="space-y-1">
        <Label htmlFor="config-notes">Line notes</Label>
        <Input
          id="config-notes"
          value={draft.itemNotes}
          onChange={(e) => onChange({ ...draft, itemNotes: e.target.value })}
          placeholder="e.g. no onions"
          className="h-10"
        />
      </div>

      <div className="mt-auto flex items-center gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Decrease quantity"
            disabled={draft.quantity <= 1}
            onClick={() => onChange({ ...draft, quantity: draft.quantity - 1 })}
          >
            <Minus />
          </Button>
          <span className="w-10 text-center text-base font-semibold tabular-nums">{draft.quantity}</span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Increase quantity"
            disabled={draft.quantity >= 99}
            onClick={() => onChange({ ...draft, quantity: draft.quantity + 1 })}
          >
            <Plus />
          </Button>
        </div>
        <Button type="button" className="h-11 flex-1 bg-ink text-parchment hover:bg-ink-soft" onClick={() => onConfirm(draft)}>
          {draft.lineKey ? "Update line" : `Add · ${amount(lineTotal)}`}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}

// ── resume hydration ────────────────────────────────────────────────────────

function rebuildLines(
  resume: ResumeOrderData,
  products: PosProduct[],
  combos: PosCombo[],
  businessTaxPct: number,
): CartLine[] {
  const lines: CartLine[] = [];
  for (const item of resume.items) {
    if (item.itemType === "combo") {
      const combo = combos.find((c) => c.id === item.comboId);
      if (!combo) continue;
      lines.push({
        key: newId(),
        itemType: "combo",
        productId: null,
        comboId: combo.id,
        variantId: null,
        name: combo.name,
        unitPriceMinor: combo.priceMinor,
        quantity: item.quantity,
        itemNotes: item.itemNotes ?? "",
        taxPct: 0,
        modifiers: [],
      });
      continue;
    }
    const product = products.find((p) => p.id === item.productId);
    if (!product) continue;
    const variant = product.variants.find((v) => v.id === item.variantId) ?? null;
    const modifiers = item.modifiers
      .flatMap(({ modifierId, quantity }) => {
        const mod = product.modifierGroups.flatMap((g) => g.modifiers).find((m) => m.id === modifierId);
        return mod ? [{ modifierId: mod.id, name: mod.name, priceMinor: mod.priceMinor, quantity }] : [];
      });
    lines.push({
      key: newId(),
      itemType: "product",
      productId: product.id,
      comboId: null,
      variantId: variant?.id ?? null,
      name: variant ? `${product.name} (${variant.name})` : product.name,
      unitPriceMinor: variant ? variant.priceMinor : product.effectivePriceMinor,
      quantity: item.quantity,
      itemNotes: item.itemNotes ?? "",
      taxPct: product.taxRatePct ?? businessTaxPct,
      modifiers,
    });
  }
  return lines;
}
