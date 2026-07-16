import assert from "node:assert/strict";
import test from "node:test";

import { APPROVAL_EVENTS, OPENING_EVENTS, projectMission } from "../lib/mission-events.ts";
import { createCheckoutMessage, SERVICEPILOT_PLANS } from "../lib/servicepilot-preview.ts";

test("the event history rebuilds the completed mission debrief", () => {
  const projection = projectMission([...OPENING_EVENTS, ...APPROVAL_EVENTS]);

  assert.equal(projection.completed, true);
  assert.equal(projection.previewReady, true);
  assert.deepEqual(projection.checks, [
    "Projection tests passed",
    "Production build passed",
    "Preview interaction passed",
  ]);
});

test("the controlled preview produces checkout evidence for every plan", () => {
  for (const plan of SERVICEPILOT_PLANS) {
    assert.equal(
      createCheckoutMessage(plan.name),
      `${plan.name} subscription is ready for Stripe test-mode checkout.`,
    );
  }
});

test("the controlled preview rejects an unknown plan", () => {
  assert.throws(() => createCheckoutMessage("Enterprise"), /Unknown ServicePilot plan/);
});
