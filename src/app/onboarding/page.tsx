import { getOnboardingContext } from "@/modules/onboarding/queries";
import { nextIncompleteStep } from "@/modules/onboarding/steps";
import { guardRedirect } from "@/lib/guarded-redirect";

/**
 * /onboarding — resume point. Picks the business still mid-setup and sends
 * the user to wherever they left off. No client-supplied tenant choice.
 */
export default async function OnboardingEntryPage() {
  const context = await getOnboardingContext();

  if (!context.business) {
    return await guardRedirect("/onboarding/business");
  }
  if (context.progress?.completedAt) {
    return await guardRedirect("/dashboard");
  }

  const completed = context.progress?.completedSteps ?? [];
  return await guardRedirect(`/onboarding/${nextIncompleteStep(completed)}`);
}
