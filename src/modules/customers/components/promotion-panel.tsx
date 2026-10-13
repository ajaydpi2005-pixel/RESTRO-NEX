"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import { applyPromotionAction, removePromotionAction } from "@/modules/customers/actions";
import { discountLabel, rupees } from "@/modules/customers/components/crm-chrome";
import { useCrmAction } from "@/modules/customers/components/use-crm-action";

export interface OrderPromotionView {
  kind: "coupon" | "reward";
  label: string;
  amountMinor: number;
  discountType: "flat" | "percent";
  discountValue: number;
  minSubtotalMinor: number;
}

export interface OrderCustomerView {
  id: string;
  name: string;
  phone: string;
  balance: number;
}

export interface VoucherView {
  id: string;
  name: string;
  pointsSpent: number;
  discountType: "flat" | "percent";
  discountValue: number;
}

/**
 * Customer, coupon and reward panel on an order. Changes are allowed only while
 * the order is open or held, unpaid and not billed. The database enforces the
 * same rules; this panel only explains them.
 */
export function PromotionPanel({
  businessId,
  orderId,
  editable,
  canApply,
  lockReason,
  promotion,
  customer,
  vouchers,
}: {
  businessId: string;
  orderId: string;
  editable: boolean;
  canApply: boolean;
  lockReason: string | null;
  promotion: OrderPromotionView | null;
  customer: OrderCustomerView | null;
  vouchers: VoucherView[];
}) {
  const canChange = editable && canApply;

  return (
    <section aria-labelledby="promo-heading" className="bg-card space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="promo-heading" className="font-display text-lg font-semibold">
          Customer &amp; promotions
        </h2>
        {customer ? (
          <Link
            href={`/customers/${customer.id}?business=${businessId}`}
            className="text-gold-deep text-sm font-medium underline-offset-4 hover:underline"
          >
            View customer →
          </Link>
        ) : null}
      </div>

      {customer ? (
        <p className="text-sm">
          <span className="font-medium">{customer.name}</span>
          <span className="text-muted-foreground">
            {" "}
            · {customer.phone} · {customer.balance} points
          </span>
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          No customer linked. Enter a phone number on the order and save to link or create the
          customer.
        </p>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">Applied promotion</p>
        {promotion ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
            <div className="text-sm">
              <p className="font-medium">{promotion.label}</p>
              <p className="text-muted-foreground">
                {promotion.kind === "coupon" ? "Coupon" : "Reward"} ·{" "}
                {discountLabel(promotion.discountType, promotion.discountValue)}
                {promotion.minSubtotalMinor > 0
                  ? ` · minimum ${rupees(promotion.minSubtotalMinor)}`
                  : ""}{" "}
                ·
                <span className="text-foreground font-medium">
                  {" "}
                  saves {rupees(promotion.amountMinor)}
                </span>
              </p>
            </div>
            {canChange ? <RemovePromotionForm businessId={businessId} orderId={orderId} /> : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">None. The order has no coupon or reward.</p>
        )}
        {promotion && promotion.amountMinor === 0 ? (
          <p className="text-muted-foreground text-xs">
            This promotion currently saves nothing. The subtotal may be below its minimum.
          </p>
        ) : null}
      </div>

      {!promotion && canChange ? (
        <div className="grid gap-4 md:grid-cols-2">
          <CouponApplyForm businessId={businessId} orderId={orderId} />

          {customer && vouchers.length > 0 ? (
            <VoucherApplyForm businessId={businessId} orderId={orderId} vouchers={vouchers} />
          ) : customer ? (
            <p className="text-muted-foreground text-sm">
              This customer has no unused reward vouchers.
            </p>
          ) : null}
        </div>
      ) : null}

      {!canChange && !promotion ? (
        <p className="text-muted-foreground text-sm">
          {!canApply
            ? "You need order and discount permission at this outlet to apply a coupon or reward."
            : (lockReason ?? "Promotions can't change on this order.")}
        </p>
      ) : null}
      {promotion && !canChange && lockReason ? (
        <p className="text-muted-foreground text-xs">{lockReason}</p>
      ) : null}
    </section>
  );
}

function CouponApplyForm({ businessId, orderId }: { businessId: string; orderId: string }) {
  const { state, formAction, pending, formRef } = useCrmAction(applyPromotionAction);
  return (
    <form ref={formRef} action={formAction} className="space-y-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={orderId} />
      <Label htmlFor="promo-code">Coupon code</Label>
      <div className="flex gap-2">
        <Input
          id="promo-code"
          name="code"
          placeholder="DIWALI10"
          maxLength={20}
          className="uppercase"
        />
        <SubmitButton
          label="Apply"
          busyLabel="Applying…"
          pending={pending}
          className="w-auto shrink-0"
        />
      </div>
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Coupon applied." : undefined} />
    </form>
  );
}

function VoucherApplyForm({
  businessId,
  orderId,
  vouchers,
}: {
  businessId: string;
  orderId: string;
  vouchers: VoucherView[];
}) {
  const { state, formAction, pending, formRef } = useCrmAction(applyPromotionAction);
  return (
    <form ref={formRef} action={formAction} className="space-y-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={orderId} />
      <Label htmlFor="promo-voucher">Reward voucher</Label>
      <div className="flex gap-2">
        <Select id="promo-voucher" name="voucherId" defaultValue="" className="min-w-0 flex-1">
          <option value="" disabled>
            Choose a voucher
          </option>
          {vouchers.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} — {discountLabel(v.discountType, v.discountValue)}
            </option>
          ))}
        </Select>
        <SubmitButton
          label="Apply"
          busyLabel="Applying…"
          pending={pending}
          className="w-auto shrink-0"
        />
      </div>
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Voucher applied." : undefined} />
    </form>
  );
}

function RemovePromotionForm({ businessId, orderId }: { businessId: string; orderId: string }) {
  const { state, formAction, pending, formRef } = useCrmAction(removePromotionAction);
  return (
    <form ref={formRef} action={formAction} className="space-y-1">
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="orderId" value={orderId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Removing…" : "Remove"}
      </Button>
      <FormError state={state} />
    </form>
  );
}
