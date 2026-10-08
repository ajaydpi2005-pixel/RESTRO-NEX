"use client";

import { useActionState } from "react";
import {
  CakeSlice,
  Coffee,
  CookingPot,
  IceCreamBowl,
  Salad,
  Sandwich,
  Truck,
  UtensilsCrossed,
  Wine,
} from "lucide-react";
import { RESTAURANT_TYPES, RESTAURANT_TYPE_LABELS } from "@/modules/business/schemas";
import { saveRestaurantTypeAction, type OnboardingActionState } from "@/modules/onboarding/actions";
import { FormError, SubmitButton } from "@/components/forms/form-bits";

const TYPE_ICONS: Record<(typeof RESTAURANT_TYPES)[number], typeof Coffee> = {
  quick_service: Sandwich,
  casual_dining: Salad,
  fine_dining: UtensilsCrossed,
  cafe: Coffee,
  cloud_kitchen: CookingPot,
  bakery: CakeSlice,
  bar_pub: Wine,
  food_truck: Truck,
  other: IceCreamBowl,
};

const TYPE_HINTS: Record<(typeof RESTAURANT_TYPES)[number], string> = {
  quick_service: "Counter ordering, fast turnaround",
  casual_dining: "Table service, relaxed atmosphere",
  fine_dining: "Full service, premium experience",
  cafe: "Coffee, beverages and light bites",
  cloud_kitchen: "Delivery-only kitchen",
  bakery: "Breads, pastries and desserts",
  bar_pub: "Drinks-led venue with food",
  food_truck: "Mobile kitchen",
  other: "Something else entirely",
};

export function RestaurantTypeForm({
  businessId,
  initialType,
}: {
  businessId: string;
  initialType: string | null;
}) {
  const [state, formAction, pending] = useActionState<OnboardingActionState | undefined, FormData>(
    saveRestaurantTypeAction,
    undefined,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="businessId" value={businessId} />
      <FormError state={state} />

      <div role="radiogroup" aria-label="Restaurant type" className="grid gap-3 sm:grid-cols-2">
        {RESTAURANT_TYPES.map((type) => {
          const Icon = TYPE_ICONS[type];
          return (
            <label
              key={type}
              className="group relative flex cursor-pointer items-start gap-3 rounded-xl border border-ink/15 bg-white p-4 transition-colors hover:border-ink/35 focus-within:ring-2 focus-within:ring-gold/60 has-[:checked]:border-gold-deep has-[:checked]:bg-gold/10"
            >
              <input
                type="radio"
                name="restaurantType"
                value={type}
                defaultChecked={initialType === type}
                required
                className="sr-only"
              />
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-ink text-gold">
                <Icon className="size-4.5" aria-hidden />
              </span>
              <span className="space-y-0.5">
                <span className="block text-sm font-medium">{RESTAURANT_TYPE_LABELS[type]}</span>
                <span className="block text-xs text-muted-foreground">{TYPE_HINTS[type]}</span>
              </span>
            </label>
          );
        })}
      </div>

      <SubmitButton label="Save & continue" busyLabel="Saving…" pending={pending} />
    </form>
  );
}
