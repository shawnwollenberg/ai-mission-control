export const SERVICEPILOT_PLANS = [
  { name: "Starter", price: "$19", interval: "month", detail: "For small service teams" },
  { name: "Growth", price: "$49", interval: "month", detail: "Automation for growing operations" },
  { name: "Growth Annual", price: "$490", interval: "year", detail: "Annual billing for growing operations" },
  { name: "Scale", price: "$99", interval: "month", detail: "Advanced controls and support" },
] as const;

export function createCheckoutMessage(planName: string): string {
  const plan = SERVICEPILOT_PLANS.find((candidate) => candidate.name === planName);
  if (!plan) throw new Error(`Unknown ServicePilot plan: ${planName}`);
  return `${plan.name} subscription is ready for Stripe test-mode checkout.`;
}
