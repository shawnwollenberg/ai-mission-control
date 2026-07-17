import assert from "node:assert/strict";
import test from "node:test";
import { checkoutPreview } from "../src/checkout-preview.ts";
import { pricingPlans } from "../src/pricing-plans.ts";

test("preserves the controlled checkout preview", () => {
  assert.equal(checkoutPreview("Growth"), "Growth subscription is ready for Stripe test-mode checkout.");
});

test("lists the existing monthly plans", () => {
  assert.deepEqual(pricingPlans.map((plan) => plan.name), ["Starter", "Growth", "Scale"]);
});
