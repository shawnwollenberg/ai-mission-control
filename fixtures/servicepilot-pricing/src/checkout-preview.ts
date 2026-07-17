import { pricingPlans } from "./pricing-plans";

export function checkoutPreview(planName: string) {
  const plan = pricingPlans.find((candidate) => candidate.name === planName);
  if (!plan) throw new Error(`Unknown ServicePilot plan: ${planName}`);
  return `${plan.name} subscription is ready for Stripe test-mode checkout.`;
}
