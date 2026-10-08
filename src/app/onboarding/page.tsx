import { redirect } from "next/navigation";
import { getOnboardingContext } from "@/modules/onboarding/queries";
import { nextIncompleteStep } from "@/modules/onboarding/steps";

/**
 * /onboarding — resume point. Picks the business still mid-setup and sends
 * the user to wherever they left off. No client-supplied tenant choice.
 */
export default async function OnboardingEntryPage() {
  const context = await getOnboardingContext();

  if (!context.business) {
    redirect("/onboarding/business");
  }
  if (context.progress?.completedAt) {
    redirect("/dashboard");
  }

  const completed = context.progress?.completedSteps ?? [];
  redirect(`/onboarding/${nextIncompleteStep(completed)}`);
}
