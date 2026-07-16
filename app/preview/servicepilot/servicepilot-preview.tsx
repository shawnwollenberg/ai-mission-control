"use client";

import { useState } from "react";
import { createCheckoutMessage, SERVICEPILOT_PLANS } from "@/lib/servicepilot-preview";

export default function ServicePilotPreview() {
  const [selectedPlan, setSelectedPlan] = useState("Growth");
  const [checkoutReady, setCheckoutReady] = useState(false);

  return (
    <main className="servicepilot-shell">
      <nav className="servicepilot-nav"><strong>ServicePilot</strong><span>Controlled preview · no live charges</span></nav>
      <section className="servicepilot-hero">
        <p>Subscription billing</p>
        <h1>Choose the plan that fits your service operation.</h1>
        <span>Stripe Billing integration preview</span>
      </section>
      <section className="pricing-grid">
        {SERVICEPILOT_PLANS.map((plan) => (
          <button className={selectedPlan === plan.name ? "selected" : ""} key={plan.name} onClick={() => { setSelectedPlan(plan.name); setCheckoutReady(false); }}>
            <span>{plan.name}</span><strong>{plan.price}<small>/month</small></strong><p>{plan.detail}</p><b>{selectedPlan === plan.name ? "Selected" : "Select plan"}</b>
          </button>
        ))}
      </section>
      <section className="checkout-panel">
        <div><span>Selected plan</span><strong>{selectedPlan}</strong></div>
        <button onClick={() => setCheckoutReady(true)}>Start subscription <span>→</span></button>
      </section>
      {checkoutReady && <section className="checkout-confirmation" aria-live="polite"><span>✓</span><div><strong>Checkout flow verified</strong><p>{createCheckoutMessage(selectedPlan)}</p></div></section>}
    </main>
  );
}
