import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("authenticated launch is not prefilled with the ServicePilot demo", async () => {
  const launch = await readFile(new URL("../app/launch-form.tsx", import.meta.url), "utf8");
  const plan = await readFile(new URL("../app/api/missions/[missionId]/plan/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(launch, /Stripe|ServicePilot/);
  assert.doesNotMatch(plan, /demo-plan|createServicePilotPlan/);
  assert.match(plan, /createObjectivePlan/);
});

test("a workspace without a connected pull agent enters onboarding", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /delivery_mode='pull'/);
  assert.match(page, /redirect\("\/onboarding"\)/);
  assert.match(page, /last_heartbeat_at IS NOT NULL/);
  assert.match(page, /pull_ready_at IS NOT NULL/);
});
