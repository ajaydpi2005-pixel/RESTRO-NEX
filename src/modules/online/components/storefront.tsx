"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  cartSignature,
  cartSubtotalMinor,
  lineTotalMinor,
  orderingBlock,
  unitPriceMinor,
  validateSelection,
  type CartLine,
} from "../cart";
import { FINAL_TOTAL_NOTE, NO_ONLINE_PAYMENT_NOTE } from "../constants";
import { formatRupees, randomUrlSafe } from "../client-random";
import type { OrderingSettings, PublicCategory, PublicMenu, PublicMenuItem } from "../types";

/**
 * Phase 17 — the customer ordering screen, used by the restaurant website and by
 * the QR table menu.
 *
 * What the browser sends: item ids, variant and option ids, quantities, notes and
 * contact details. It never sends a price, discount, tax, fee or status. Totals on
 * screen are estimates; the server prices the order and returns the final figures.
 *
 * Retries: the client key and tracking secret are reused only when the cart and
 * form are unchanged. A changed order always gets a new key, so a retry can never
 * replay an older order.
 */

export interface StorefrontProps {
  mode: "online" | "qr";
  businessName: string;
  outletName: string;
  businessSlug?: string;
  outletSlug?: string;
  qrToken?: string;
  tableLabel?: string;
  settings: OrderingSettings;
  menu: PublicMenu;
}

interface Form {
  name: string;
  phone: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: Form = { name: "", phone: "", address: "", notes: "" };

export function Storefront(props: StorefrontProps) {
  const { mode, businessName, outletName, settings, menu } = props;
  const router = useRouter();

  const [lines, setLines] = useState<CartLine[]>([]);
  const [openItemId, setOpenItemId] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [orderType, setOrderType] = useState<"takeaway" | "delivery">(
    settings.takeaway_enabled ? "takeaway" : "delivery",
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const pendingRef = useRef<{ signature: string; clientRef: string; secret: string } | null>(null);

  const channelBlock = orderingBlock(settings, mode, mode === "online" ? orderType : null);
  const canOrder = channelBlock === null;
  const subtotal = cartSubtotalMinor(lines);
  const belowMinimum =
    mode === "online" && settings.min_order_minor > 0 && subtotal < settings.min_order_minor;
  const estimatedFees =
    mode === "online"
      ? (orderType === "delivery" ? settings.delivery_fee_minor : 0) + settings.packaging_fee_minor
      : 0;

  const parentNames = new Map(menu.categories.map((c) => [c.id, c.name]));

  function addLine(
    item: PublicMenuItem,
    selection: { variantId: string | null; modifierIds: string[]; quantity: number; notes: string },
  ) {
    const problem = validateSelection({
      item,
      variantId: selection.variantId,
      selectedModifierIds: selection.modifierIds,
      quantity: selection.quantity,
    });
    if (problem) {
      setError(problem);
      return;
    }
    const variant = item.variants.find((v) => v.id === selection.variantId) ?? null;
    const modifiers = item.modifier_groups.flatMap((g) =>
      g.modifiers
        .filter((m) => selection.modifierIds.includes(m.id))
        .map((m) => ({ id: m.id, name: m.name, price_minor: m.price_minor })),
    );
    const line: CartLine = {
      lineId: randomUrlSafe(8),
      kind: item.item_type,
      itemId: item.id,
      itemName: item.name,
      variant: variant
        ? { id: variant.id, name: variant.name, price_minor: variant.price_minor }
        : null,
      modifiers,
      quantity: selection.quantity,
      notes: selection.notes.trim() || null,
      unitMinor: unitPriceMinor(item, variant, modifiers),
    };
    setLines((current) => [...current, line]);
    setError(null);
    setOpenItemId(null);
  }

  function changeQuantity(lineId: string, delta: number) {
    setLines((current) =>
      current
        .map((l) =>
          l.lineId === lineId ? { ...l, quantity: Math.min(99, l.quantity + delta) } : l,
        )
        .filter((l) => l.quantity > 0),
    );
  }

  function removeLine(lineId: string) {
    setLines((current) => current.filter((l) => l.lineId !== lineId));
  }

  async function placeOrder() {
    setError(null);
    setFieldErrors({});

    if (lines.length === 0) {
      setError("Add something to your order first.");
      return;
    }
    if (channelBlock) {
      setError(channelBlock);
      return;
    }
    if (belowMinimum) {
      setError(`The minimum order here is ₹${formatRupees(settings.min_order_minor)}.`);
      return;
    }

    const signature = cartSignature(lines, { ...form, orderType });
    if (!pendingRef.current || pendingRef.current.signature !== signature) {
      pendingRef.current = { signature, clientRef: randomUrlSafe(16), secret: randomUrlSafe(32) };
    }
    const { clientRef, secret } = pendingRef.current;

    const body =
      mode === "online"
        ? {
            channel: "online",
            businessSlug: props.businessSlug,
            outletSlug: props.outletSlug,
            clientRef,
            trackingSecret: secret,
            orderType,
            customerName: form.name,
            customerPhone: form.phone,
            deliveryAddress: orderType === "delivery" ? form.address : undefined,
            notes: form.notes,
            items: lines.map(toRequestItem),
          }
        : {
            channel: "qr",
            qrToken: props.qrToken,
            clientRef,
            trackingSecret: secret,
            customerName: form.name,
            notes: form.notes,
            items: lines.map(toRequestItem),
          };

    setSubmitting(true);
    try {
      const response = await fetch("/api/public/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: Record<string, string[]>;
        order?: { order_id: string };
      };
      if (!response.ok || !data.order) {
        setError(data.error ?? "Your order could not be placed. Please try again.");
        setFieldErrors(data.fieldErrors ?? {});
        return;
      }
      pendingRef.current = null;
      router.push(`/track/${data.order.order_id}#s=${secret}`);
    } catch {
      setError("A network problem stopped your order. Nothing was charged. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const heading = mode === "qr" ? `Table ${props.tableLabel ?? ""}`.trim() : outletName;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:py-10">
      <header className="space-y-1">
        <p className="text-muted-foreground text-xs font-semibold tracking-widest uppercase">
          {businessName}
        </p>
        <h1 className="font-display text-3xl font-semibold tracking-tight">{heading}</h1>
        <p className="text-muted-foreground text-sm">
          {mode === "qr"
            ? "Order from your table. Staff confirm each order before it goes to the kitchen."
            : "Order online for takeaway or delivery. The restaurant confirms each order before it is prepared."}
        </p>
      </header>

      {channelBlock ? (
        <p role="status" className="border-gold/50 bg-gold/10 rounded-lg border px-4 py-3 text-sm">
          {channelBlock} You can still browse the menu.
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-label="Menu" className="space-y-8">
          {menu.categories.length === 0 && menu.combos.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              The menu is being updated. Please check back shortly.
            </p>
          ) : null}

          {menu.categories.map((category) => (
            <CategorySection
              key={category.id}
              category={category}
              parentName={category.parent_id ? (parentNames.get(category.parent_id) ?? null) : null}
              openItemId={openItemId}
              onOpen={(id) => setOpenItemId((current) => (current === id ? null : id))}
              onAdd={addLine}
              canOrder={canOrder}
            />
          ))}

          {menu.combos.length > 0 ? (
            <CategorySection
              category={{ id: "combos", name: "Combos", parent_id: null, items: menu.combos }}
              parentName={null}
              openItemId={openItemId}
              onOpen={(id) => setOpenItemId((current) => (current === id ? null : id))}
              onAdd={addLine}
              canOrder={canOrder}
            />
          ) : null}
        </section>

        <aside id="cart" aria-label="Your order" className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardContent className="space-y-5 p-5">
              <h2 className="font-display text-xl font-semibold">Your order</h2>

              {lines.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nothing yet. Choose items from the menu.
                </p>
              ) : (
                <ul className="space-y-3">
                  {lines.map((line) => (
                    <li
                      key={line.lineId}
                      className="border-border space-y-1 border-b pb-3 last:border-0"
                    >
                      <div className="flex items-start justify-between gap-3 text-sm">
                        <span className="font-medium">
                          {line.itemName}
                          {line.variant ? (
                            <span className="text-muted-foreground"> · {line.variant.name}</span>
                          ) : null}
                        </span>
                        <span className="tabular-nums">₹{formatRupees(lineTotalMinor(line))}</span>
                      </div>
                      {line.modifiers.length > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          {line.modifiers.map((m) => m.name).join(", ")}
                        </p>
                      ) : null}
                      {line.notes ? (
                        <p className="text-muted-foreground text-xs">Note: {line.notes}</p>
                      ) : null}
                      <div className="flex items-center gap-2 pt-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => changeQuantity(line.lineId, -1)}
                          aria-label={`Reduce ${line.itemName}`}
                        >
                          −
                        </Button>
                        <span className="w-6 text-center text-sm tabular-nums">
                          {line.quantity}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => changeQuantity(line.lineId, 1)}
                          aria-label={`Increase ${line.itemName}`}
                        >
                          +
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          onClick={() => removeLine(line.lineId)}
                        >
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <dl className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Items (estimate)</dt>
                  <dd className="tabular-nums">₹{formatRupees(subtotal)}</dd>
                </div>
                {estimatedFees > 0 ? (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">Fees (estimate)</dt>
                    <dd className="tabular-nums">₹{formatRupees(estimatedFees)}</dd>
                  </div>
                ) : null}
              </dl>
              <p className="text-muted-foreground text-xs">{FINAL_TOTAL_NOTE}</p>

              {mode === "online" ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">How would you like it?</legend>
                  <div className="flex gap-2">
                    {settings.takeaway_enabled ? (
                      <ChoiceButton
                        active={orderType === "takeaway"}
                        onClick={() => setOrderType("takeaway")}
                      >
                        Takeaway
                      </ChoiceButton>
                    ) : null}
                    {settings.delivery_enabled ? (
                      <ChoiceButton
                        active={orderType === "delivery"}
                        onClick={() => setOrderType("delivery")}
                      >
                        Delivery
                      </ChoiceButton>
                    ) : null}
                  </div>
                </fieldset>
              ) : (
                <p className="text-sm">
                  <span className="font-medium">Table:</span> {props.tableLabel ?? "your table"}
                </p>
              )}

              <div className="space-y-3">
                <Field
                  id="customer-name"
                  label="Your name"
                  value={form.name}
                  onChange={(v) => setForm({ ...form, name: v })}
                  maxLength={80}
                  errors={fieldErrors.customerName}
                  autoComplete="name"
                />
                {mode === "online" ? (
                  <Field
                    id="customer-phone"
                    label="Phone number"
                    value={form.phone}
                    onChange={(v) => setForm({ ...form, phone: v })}
                    maxLength={20}
                    inputMode="tel"
                    autoComplete="tel"
                    required
                    errors={fieldErrors.customerPhone}
                    hint="We call or message you about this order."
                  />
                ) : null}
                {mode === "online" && orderType === "delivery" ? (
                  <Field
                    id="delivery-address"
                    label="Delivery address"
                    value={form.address}
                    onChange={(v) => setForm({ ...form, address: v })}
                    maxLength={300}
                    required
                    errors={fieldErrors.deliveryAddress}
                    autoComplete="street-address"
                  />
                ) : null}
                <Field
                  id="order-notes"
                  label="Notes for the kitchen"
                  value={form.notes}
                  onChange={(v) => setForm({ ...form, notes: v })}
                  maxLength={400}
                  errors={fieldErrors.notes}
                />
              </div>

              <p className="bg-muted text-muted-foreground rounded-md px-3 py-2 text-xs">
                {NO_ONLINE_PAYMENT_NOTE}
              </p>

              {belowMinimum ? (
                <p className="text-muted-foreground text-sm">
                  Minimum order is ₹{formatRupees(settings.min_order_minor)}.
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-destructive text-sm">
                  {error}
                </p>
              ) : null}

              <Button
                type="button"
                className="w-full"
                disabled={submitting || !canOrder || lines.length === 0 || belowMinimum}
                onClick={placeOrder}
              >
                {submitting ? "Placing order…" : mode === "qr" ? "Send to staff" : "Place order"}
              </Button>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function toRequestItem(line: CartLine) {
  return {
    kind: line.kind,
    id: line.itemId,
    variantId: line.variant?.id ?? null,
    quantity: line.quantity,
    notes: line.notes,
    modifiers: line.modifiers.map((m) => ({ id: m.id, quantity: 1 })),
  };
}

function ChoiceButton({
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
      aria-pressed={active}
      className={cn(
        "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition",
        active
          ? "border-gold bg-gold/15 text-foreground"
          : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Field(props: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  maxLength: number;
  required?: boolean;
  inputMode?: "tel" | "text";
  autoComplete?: string;
  errors?: string[];
  hint?: string;
}) {
  const describedBy =
    [props.hint ? `${props.id}-hint` : null, props.errors ? `${props.id}-error` : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="space-y-1">
      <Label htmlFor={props.id}>
        {props.label}
        {props.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <Input
        id={props.id}
        value={props.value}
        maxLength={props.maxLength}
        required={props.required}
        inputMode={props.inputMode}
        autoComplete={props.autoComplete}
        aria-describedby={describedBy}
        aria-invalid={props.errors ? true : undefined}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint ? (
        <p id={`${props.id}-hint`} className="text-muted-foreground text-xs">
          {props.hint}
        </p>
      ) : null}
      {props.errors?.map((message) => (
        <p key={message} id={`${props.id}-error`} className="text-destructive text-xs">
          {message}
        </p>
      ))}
    </div>
  );
}

function CategorySection(props: {
  category: PublicCategory;
  parentName: string | null;
  openItemId: string | null;
  onOpen: (id: string) => void;
  onAdd: Parameters<typeof ItemCard>[0]["onAdd"];
  canOrder: boolean;
}) {
  if (props.category.items.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="font-display text-xl font-semibold">
        {props.parentName ? (
          <span className="text-muted-foreground">{props.parentName} · </span>
        ) : null}
        {props.category.name}
      </h2>
      <ul className="space-y-3">
        {props.category.items.map((item) => (
          <ItemCard
            key={item.id}
            item={item}
            open={props.openItemId === item.id}
            onToggle={() => props.onOpen(item.id)}
            onAdd={props.onAdd}
            canOrder={props.canOrder}
          />
        ))}
      </ul>
    </div>
  );
}

function ItemCard(props: {
  item: PublicMenuItem;
  open: boolean;
  onToggle: () => void;
  onAdd: (
    item: PublicMenuItem,
    selection: { variantId: string | null; modifierIds: string[]; quantity: number; notes: string },
  ) => void;
  canOrder: boolean;
}) {
  const { item } = props;
  const startPrice =
    item.variants.length > 0
      ? Math.min(...item.variants.map((v) => v.price_minor))
      : item.price_minor;
  const hasOptions = item.variants.length > 0 || item.modifier_groups.length > 0;

  return (
    <li className="border-border bg-card rounded-xl border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            {item.name}{" "}
            <span
              aria-label={item.is_vegetarian ? "Vegetarian" : "Non-vegetarian"}
              className={cn(
                "ml-1 inline-block size-2.5 rounded-sm align-middle",
                item.is_vegetarian ? "bg-green-600" : "bg-red-600",
              )}
            />
          </p>
          {item.description ? (
            <p className="text-muted-foreground text-sm">{item.description}</p>
          ) : null}
          <p className="text-sm tabular-nums">
            {item.variants.length > 0 ? "from " : ""}₹{formatRupees(startPrice)}
          </p>
        </div>
        {props.canOrder ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onToggle}
            aria-expanded={props.open}
          >
            {props.open ? "Close" : hasOptions ? "Customise" : "Add"}
          </Button>
        ) : null}
      </div>
      {props.open && props.canOrder ? (
        <ItemOptions item={item} onAdd={(sel) => props.onAdd(item, sel)} />
      ) : null}
    </li>
  );
}

function ItemOptions(props: {
  item: PublicMenuItem;
  onAdd: (selection: {
    variantId: string | null;
    modifierIds: string[];
    quantity: number;
    notes: string;
  }) => void;
}) {
  const { item } = props;
  const [variantId, setVariantId] = useState<string | null>(item.variants[0]?.id ?? null);
  const [modifierIds, setModifierIds] = useState<string[]>([]);
  const [quantity, setQuantity] = useState(1);
  const [notes, setNotes] = useState("");

  function toggleModifier(groupId: string, modifierId: string, max: number | null) {
    const group = item.modifier_groups.find((g) => g.id === groupId);
    const groupIds = group?.modifiers.map((m) => m.id) ?? [];
    setModifierIds((current) => {
      if (current.includes(modifierId)) return current.filter((id) => id !== modifierId);
      // A single-choice group swaps its previous choice; a multi-choice group adds, up to its limit.
      const others = current.filter((id) => !groupIds.includes(id));
      const inGroup = current.filter((id) => groupIds.includes(id));
      if (max === 1) return [...others, modifierId];
      if (max !== null && inGroup.length >= max) return current;
      return [...current, modifierId];
    });
  }

  return (
    <div className="border-border mt-4 space-y-4 border-t pt-4">
      {item.variants.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Size</legend>
          <div className="flex flex-wrap gap-2">
            {item.variants.map((variant) => (
              <ChoiceButton
                key={variant.id}
                active={variantId === variant.id}
                onClick={() => setVariantId(variant.id)}
              >
                {variant.name} · ₹{formatRupees(variant.price_minor)}
              </ChoiceButton>
            ))}
          </div>
        </fieldset>
      ) : null}

      {item.modifier_groups.map((group) => (
        <fieldset key={group.id} className="space-y-2">
          <legend className="text-sm font-medium">
            {group.name}
            <span className="text-muted-foreground ml-2 text-xs font-normal">
              {group.min_selected > 0 ? `Required, choose ${group.min_selected}` : "Optional"}
              {group.max_selected !== null ? ` · up to ${group.max_selected}` : ""}
            </span>
          </legend>
          <div className="space-y-1">
            {group.modifiers.map((modifier) => {
              const checked = modifierIds.includes(modifier.id);
              return (
                <label
                  key={modifier.id}
                  className="hover:bg-muted flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleModifier(group.id, modifier.id, group.max_selected)}
                      className="accent-gold size-4"
                    />
                    {modifier.name}
                  </span>
                  {modifier.price_minor > 0 ? (
                    <span className="text-muted-foreground tabular-nums">
                      +₹{formatRupees(modifier.price_minor)}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setQuantity((q) => Math.max(1, q - 1))}
          aria-label="Fewer"
        >
          −
        </Button>
        <span className="w-6 text-center text-sm tabular-nums">{quantity}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setQuantity((q) => Math.min(99, q + 1))}
          aria-label="More"
        >
          +
        </Button>
      </div>

      <Field
        id={`notes-${item.id}`}
        label="Special instructions"
        value={notes}
        onChange={setNotes}
        maxLength={200}
      />

      <Button
        type="button"
        className="w-full"
        onClick={() => props.onAdd({ variantId, modifierIds, quantity, notes })}
      >
        Add to order
      </Button>
    </div>
  );
}
