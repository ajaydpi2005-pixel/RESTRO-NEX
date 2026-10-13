"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { FormError, FormSuccess, SubmitButton } from "@/components/forms/form-bits";
import {
  adjustPointsAction,
  redeemRewardAction,
  saveCouponAction,
  saveLoyaltySettingsAction,
  saveRewardAction,
} from "@/modules/customers/actions";
import { useCrmAction } from "@/modules/customers/components/use-crm-action";
import { minorToDisplay } from "@/modules/menu/schemas";
import type { CouponRow, LoyaltySettingsRow, RewardRow } from "@/modules/customers/queries";

const field = "space-y-1.5";

export function LoyaltySettingsForm({
  businessId,
  settings,
}: {
  businessId: string;
  settings: LoyaltySettingsRow;
}) {
  const { state, formAction, pending, formRef } = useCrmAction(saveLoyaltySettingsAction, {
    resetOnSuccess: false,
  });
  return (
    <form ref={formRef} action={formAction} className="grid gap-4 sm:grid-cols-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />
      <FormSuccess message={state?.ok ? "Loyalty settings saved." : undefined} />
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          name="enabled"
          value="on"
          defaultChecked={settings.enabled}
          className="size-4"
        />
        Earn points on completed orders
      </label>
      <div className={field}>
        <Label htmlFor="earn-rupees">Net spend per point (₹)</Label>
        <Input
          id="earn-rupees"
          name="earnRupeesPerPoint"
          type="number"
          min={1}
          step="0.01"
          defaultValue={minorToDisplay(settings.earnMinorPerPoint)}
          required
        />
        <p className="text-muted-foreground text-xs">
          Points = floor(net spend ÷ this amount). Net spend is after discounts and refunds.
        </p>
      </div>
      <div className="sm:col-span-2">
        <SubmitButton
          label="Save loyalty settings"
          busyLabel="Saving…"
          pending={pending}
          className="sm:w-auto"
        />
      </div>
    </form>
  );
}

/** Create or edit a reward. Flat values are rupees; percent values are whole numbers. */
export function RewardForm({ businessId, reward }: { businessId: string; reward?: RewardRow }) {
  const editing = Boolean(reward);
  const suffix = reward?.id ?? "new";
  const { state, formAction, pending, formRef } = useCrmAction(saveRewardAction, {
    resetOnSuccess: !editing,
  });
  const displayValue = reward
    ? reward.discountType === "flat"
      ? minorToDisplay(reward.discountValue)
      : String(reward.discountValue)
    : "";
  return (
    <form ref={formRef} action={formAction} className="grid gap-3 sm:grid-cols-2" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="id" value={reward?.id ?? ""} />
      <FormError state={state} />
      <FormSuccess
        message={state?.ok ? (editing ? "Reward saved." : "Reward added.") : undefined}
      />
      <div className={field}>
        <Label htmlFor={`rw-name-${suffix}`}>Name</Label>
        <Input
          id={`rw-name-${suffix}`}
          name="name"
          defaultValue={reward?.name ?? ""}
          maxLength={80}
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`rw-points-${suffix}`}>Points cost</Label>
        <Input
          id={`rw-points-${suffix}`}
          name="pointsCost"
          type="number"
          min={1}
          step={1}
          defaultValue={reward?.pointsCost ?? ""}
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`rw-type-${suffix}`}>Discount type</Label>
        <Select
          id={`rw-type-${suffix}`}
          name="discountType"
          defaultValue={reward?.discountType ?? "flat"}
        >
          <option value="flat">Flat amount (₹)</option>
          <option value="percent">Percent (%)</option>
        </Select>
      </div>
      <div className={field}>
        <Label htmlFor={`rw-value-${suffix}`}>Discount value</Label>
        <Input
          id={`rw-value-${suffix}`}
          name="discountValue"
          type="number"
          min={0}
          step="0.01"
          defaultValue={displayValue}
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`rw-max-${suffix}`}>Maximum discount, ₹ (optional)</Label>
        <Input
          id={`rw-max-${suffix}`}
          name="maxDiscount"
          type="number"
          min={0}
          step="0.01"
          defaultValue={
            reward?.maxDiscountMinor != null ? minorToDisplay(reward.maxDiscountMinor) : ""
          }
        />
      </div>
      <label className="flex items-center gap-2 self-end text-sm">
        <input
          type="checkbox"
          name="active"
          value="on"
          defaultChecked={reward?.active ?? true}
          className="size-4"
        />
        Active
      </label>
      <div className="sm:col-span-2">
        <SubmitButton
          label={editing ? "Save reward" : "Add reward"}
          busyLabel="Saving…"
          pending={pending}
          className="sm:w-auto"
        />
      </div>
    </form>
  );
}

/** Create or edit a coupon. Codes are stored in upper case. */
export function CouponForm({ businessId, coupon }: { businessId: string; coupon?: CouponRow }) {
  const editing = Boolean(coupon);
  const suffix = coupon?.id ?? "new";
  const { state, formAction, pending, formRef } = useCrmAction(saveCouponAction, {
    resetOnSuccess: !editing,
  });
  const displayValue = coupon
    ? coupon.discountType === "flat"
      ? minorToDisplay(coupon.discountValue)
      : String(coupon.discountValue)
    : "";
  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
      noValidate
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="id" value={coupon?.id ?? ""} />
      <FormError state={state} />
      <FormSuccess
        message={state?.ok ? (editing ? "Coupon saved." : "Coupon added.") : undefined}
      />
      <div className={field}>
        <Label htmlFor={`cp-code-${suffix}`}>Code</Label>
        <Input
          id={`cp-code-${suffix}`}
          name="code"
          defaultValue={coupon?.code ?? ""}
          maxLength={20}
          placeholder="DIWALI10"
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-name-${suffix}`}>Name</Label>
        <Input
          id={`cp-name-${suffix}`}
          name="name"
          defaultValue={coupon?.name ?? ""}
          maxLength={80}
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-type-${suffix}`}>Discount type</Label>
        <Select
          id={`cp-type-${suffix}`}
          name="discountType"
          defaultValue={coupon?.discountType ?? "percent"}
        >
          <option value="percent">Percent (%)</option>
          <option value="flat">Flat amount (₹)</option>
        </Select>
      </div>
      <div className={field}>
        <Label htmlFor={`cp-value-${suffix}`}>Discount value</Label>
        <Input
          id={`cp-value-${suffix}`}
          name="discountValue"
          type="number"
          min={0}
          step="0.01"
          defaultValue={displayValue}
          required
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-max-${suffix}`}>Maximum discount, ₹ (optional)</Label>
        <Input
          id={`cp-max-${suffix}`}
          name="maxDiscount"
          type="number"
          min={0}
          step="0.01"
          defaultValue={
            coupon?.maxDiscountMinor != null ? minorToDisplay(coupon.maxDiscountMinor) : ""
          }
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-min-${suffix}`}>Minimum bill, ₹</Label>
        <Input
          id={`cp-min-${suffix}`}
          name="minSubtotal"
          type="number"
          min={0}
          step="0.01"
          defaultValue={coupon ? minorToDisplay(coupon.minSubtotalMinor) : "0"}
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-start-${suffix}`}>Starts on (optional)</Label>
        <Input
          id={`cp-start-${suffix}`}
          name="startsOn"
          type="date"
          defaultValue={coupon?.startsOn ?? ""}
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-end-${suffix}`}>Ends on (optional)</Label>
        <Input
          id={`cp-end-${suffix}`}
          name="endsOn"
          type="date"
          defaultValue={coupon?.endsOn ?? ""}
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-limit-${suffix}`}>Total uses (optional)</Label>
        <Input
          id={`cp-limit-${suffix}`}
          name="usageLimit"
          type="number"
          min={1}
          step={1}
          defaultValue={coupon?.usageLimit ?? ""}
        />
      </div>
      <div className={field}>
        <Label htmlFor={`cp-per-${suffix}`}>Uses per customer (optional)</Label>
        <Input
          id={`cp-per-${suffix}`}
          name="perCustomerLimit"
          type="number"
          min={1}
          step={1}
          defaultValue={coupon?.perCustomerLimit ?? ""}
        />
      </div>
      <label className="flex items-center gap-2 self-end text-sm">
        <input
          type="checkbox"
          name="active"
          value="on"
          defaultChecked={coupon?.active ?? true}
          className="size-4"
        />
        Active
      </label>
      <div className="sm:col-span-2 lg:col-span-3">
        <SubmitButton
          label={editing ? "Save coupon" : "Add coupon"}
          busyLabel="Saving…"
          pending={pending}
          className="sm:w-auto"
        />
      </div>
    </form>
  );
}

/** Manual points adjustment. Needs a reason; the ledger records who and why. */
export function PointsAdjustForm({
  businessId,
  customerId,
}: {
  businessId: string;
  customerId: string;
}) {
  const { state, formAction, pending, formRef, clientRef } = useCrmAction(adjustPointsAction);
  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid gap-3 sm:grid-cols-[1fr_2fr_auto] sm:items-end"
      noValidate
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="clientRef" value={clientRef} />
      <div className={field}>
        <Label htmlFor="pts-points">Points (use − to take away)</Label>
        <Input id="pts-points" name="points" type="number" step={1} required />
      </div>
      <div className={field}>
        <Label htmlFor="pts-reason">Reason</Label>
        <Input id="pts-reason" name="reason" maxLength={200} required />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving…" : "Adjust points"}
      </Button>
      <div className="space-y-2 sm:col-span-3">
        <FormError state={state} />
        <FormSuccess
          message={
            state?.ok
              ? state.duplicate
                ? "That adjustment was already recorded."
                : "Points adjusted."
              : undefined
          }
        />
      </div>
    </form>
  );
}

/** Spends points on a reward. A repeated submit with the same reference is ignored. */
export function RedeemRewardForm({
  businessId,
  customerId,
  rewards,
  balance,
}: {
  businessId: string;
  customerId: string;
  rewards: RewardRow[];
  balance: number;
}) {
  const { state, formAction, pending, formRef, clientRef } = useCrmAction(redeemRewardAction);
  const affordable = rewards.filter((r) => r.active);
  if (affordable.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No active rewards yet. Add one under Loyalty &amp; coupons.
      </p>
    );
  }
  return (
    <form
      ref={formRef}
      action={formAction}
      className="grid gap-3 sm:grid-cols-[2fr_auto] sm:items-end"
      noValidate
    >
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="customerId" value={customerId} />
      <input type="hidden" name="clientRef" value={clientRef} />
      <div className={field}>
        <Label htmlFor="rd-reward">Reward</Label>
        <Select id="rd-reward" name="rewardId" defaultValue="" required>
          <option value="" disabled>
            Choose a reward
          </option>
          {affordable.map((r) => (
            <option key={r.id} value={r.id} disabled={r.pointsCost > balance}>
              {r.name} — {r.pointsCost} pts{r.pointsCost > balance ? " (not enough)" : ""}
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Issuing…" : "Issue voucher"}
      </Button>
      <div className="space-y-2 sm:col-span-2">
        <FormError state={state} />
        <FormSuccess
          message={
            state?.ok
              ? state.duplicate
                ? "That voucher was already issued."
                : "Voucher issued. Apply it on an order."
              : undefined
          }
        />
      </div>
    </form>
  );
}
