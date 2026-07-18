import assert from "node:assert/strict";
import test from "node:test";
import { checkoutPreview } from "../src/checkout-preview.ts";
import { pricingPlans } from "../src/pricing-plans.ts";

test("preserves the controlled checkout preview", () => {
  assert.equal(checkoutPreview("Growth"), "Growth subscription is ready for Stripe test-mode checkout.");
});

test("lists the annual ServicePilot pricing option", () => {
  assert.deepEqual(
    pricingPlans.map((plan) => plan.name),
    ["Starter", "Growth", "Growth Annual", "Scale"],
  );
  assert.deepEqual(
    pricingPlans.find((plan) => plan.name === "Growth Annual"),
    { name: "Growth Annual", annualPrice: 490, interval: "year" },
  );
});
