"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { priceToMinorUnits, minorToDisplay } from "@/modules/menu/schemas";
import { saveOrderingSettingsAction } from "../actions";
import { PREP_MINUTES_MAX, PREP_MINUTES_MIN } from "../constants";
import type { OrderingSettings } from "../types";

/**
 * Phase 17 — per-outlet ordering settings. Money is typed in rupees and converted
 * to paise by the shared parser. The server validates the result again.
 */

interface Draft {
  onlineEnabled: boolean;
  takeawayEnabled: boolean;
  deliveryEnabled: boolean;
  qrEnabled: boolean;
  acceptingOrders: boolean;
  autoAccept: boolean;
  minOrder: string;
  deliveryFee: string;
  packagingFee: string;
  prepMinutes: string;
}

function toDraft(s: OrderingSettings): Draft {
  return {
    onlineEnabled: s.online_enabled,
    takeawayEnabled: s.takeaway_enabled,
    deliveryEnabled: s.delivery_enabled,
    qrEnabled: s.qr_enabled,
    acceptingOrders: s.accepting_orders,
    autoAccept: s.auto_accept,
    minOrder: minorToDisplay(s.min_order_minor),
    deliveryFee: minorToDisplay(s.delivery_fee_minor),
    packagingFee: minorToDisplay(s.packaging_fee_minor),
    prepMinutes: String(s.prep_minutes),
  };
}

export function OrderingSettingsForm(props: {
  businessId: string;
  outletId: string;
  initial: OrderingSettings;
  canManage: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(props.initial));
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function save() {
    setMessage(null);
    const minOrderMinor = priceToMinorUnits(draft.minOrder || "0");
    const deliveryFeeMinor = priceToMinorUnits(draft.deliveryFee || "0");
    const packagingFeeMinor = priceToMinorUnits(draft.packagingFee || "0");
    const prep = Number(draft.prepMinutes);
    if (minOrderMinor === null || deliveryFeeMinor === null || packagingFeeMinor === null) {
      setMessage({ tone: "error", text: "Enter amounts in rupees, like 150 or 99.50." });
      return;
    }
    if (!Number.isInteger(prep) || prep < PREP_MINUTES_MIN || prep > PREP_MINUTES_MAX) {
      setMessage({
        tone: "error",
        text: `Preparation time must be ${PREP_MINUTES_MIN}–${PREP_MINUTES_MAX} minutes.`,
      });
      return;
    }

    startTransition(async () => {
      const result = await saveOrderingSettingsAction({
        businessId: props.businessId,
        outletId: props.outletId,
        onlineEnabled: draft.onlineEnabled,
        takeawayEnabled: draft.takeawayEnabled,
        deliveryEnabled: draft.deliveryEnabled,
        qrEnabled: draft.qrEnabled,
        acceptingOrders: draft.acceptingOrders,
        autoAccept: draft.autoAccept,
        minOrderMinor,
        deliveryFeeMinor,
        packagingFeeMinor,
        prepMinutes: prep,
      });
      setMessage(
        result.ok
          ? { tone: "ok", text: "Saved. Customers see the new settings straight away." }
          : { tone: "error", text: result.error },
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ordering settings</CardTitle>
        <CardDescription>
          Choose which ways customers can order from this outlet. Settings take effect for new
          orders.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <fieldset disabled={!props.canManage || pending} className="space-y-6">
          <legend className="sr-only">Ordering options</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Toggle
              label="Accept online orders (website)"
              checked={draft.onlineEnabled}
              onChange={(v) => set("onlineEnabled", v)}
            />
            <Toggle
              label="Takeaway"
              checked={draft.takeawayEnabled}
              onChange={(v) => set("takeawayEnabled", v)}
            />
            <Toggle
              label="Delivery"
              checked={draft.deliveryEnabled}
              onChange={(v) => set("deliveryEnabled", v)}
            />
            <Toggle
              label="Table ordering by QR code"
              checked={draft.qrEnabled}
              onChange={(v) => set("qrEnabled", v)}
            />
            <Toggle
              label="Accepting orders right now"
              checked={draft.acceptingOrders}
              onChange={(v) => set("acceptingOrders", v)}
            />
            <Toggle
              label="Auto-accept orders"
              hint="Off by default. Each order waits for staff to accept it."
              checked={draft.autoAccept}
              onChange={(v) => set("autoAccept", v)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyField
              label="Minimum order (₹)"
              hint="Applies to website orders only. Use 0 for none."
              value={draft.minOrder}
              onChange={(v) => set("minOrder", v)}
            />
            <MoneyField
              label="Delivery fee (₹)"
              value={draft.deliveryFee}
              onChange={(v) => set("deliveryFee", v)}
            />
            <MoneyField
              label="Packaging fee (₹)"
              value={draft.packagingFee}
              onChange={(v) => set("packagingFee", v)}
            />
            <div className="space-y-1">
              <Label htmlFor="prep-minutes">Preparation time (minutes)</Label>
              <Input
                id="prep-minutes"
                type="number"
                inputMode="numeric"
                min={PREP_MINUTES_MIN}
                max={PREP_MINUTES_MAX}
                value={draft.prepMinutes}
                onChange={(e) => set("prepMinutes", e.target.value)}
              />
            </div>
          </div>
        </fieldset>

        {props.canManage ? (
          <div className="flex items-center gap-3">
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save settings"}
            </Button>
            {message ? (
              <p
                role="status"
                className={
                  message.tone === "ok"
                    ? "text-sm text-green-700 dark:text-green-400"
                    : "text-destructive text-sm"
                }
              >
                {message.text}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Only owners and managers can change ordering settings.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle(props: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="border-border flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="accent-gold mt-0.5 size-4"
      />
      <span className="space-y-0.5">
        <span className="block font-medium">{props.label}</span>
        {props.hint ? (
          <span className="text-muted-foreground block text-xs">{props.hint}</span>
        ) : null}
      </span>
    </label>
  );
}

function MoneyField(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = props.label.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{props.label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint ? <p className="text-muted-foreground text-xs">{props.hint}</p> : null}
    </div>
  );
}
