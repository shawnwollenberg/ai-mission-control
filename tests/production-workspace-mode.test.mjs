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

test("a workspace without a connected pull agent gets an explicit first-run home", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /delivery_mode='pull'/);
  assert.match(page, /Connect your first agent/);
  assert.match(page, /FirstRunHome/);
  assert.match(page, /last_heartbeat_at>now\(\)-interval '5 minutes'/);
  assert.match(page, /pull_ready_at>now\(\)-interval '5 minutes'/);
});

test("authenticated launch makes live repository work primary and keeps the demo separate", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const launch = await readFile(new URL("../app/first-mission-form.tsx", import.meta.url), "utf8");
  assert.match(page, /last_heartbeat_at>now\(\)-interval '5 minutes'/);
  assert.doesNotMatch(page, /firstMission/);
  assert.match(launch, /Live repository mission/);
  assert.match(launch, /href="\/preview\/servicepilot"/);
  assert.match(launch, /Run Demo/);
  assert.match(launch, /Analysis objective/);
  assert.doesNotMatch(launch, /readOnly/);
});

test("stale registered agents are shown as reconnecting instead of unconfigured", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /ReconnectAgentHome/);
  assert.match(page, /Your agent and repositories are still registered/);
});
