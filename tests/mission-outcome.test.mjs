import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = await mkdtemp(path.join(os.tmpdir(), "mission-control-events-"));
process.env.MISSION_CONTROL_DATA_DIR = dataDir;

const {
  appendMissionEvent,
  appendAgentEvent,
  appendNextControlledEvent,
  approveRecommendation,
  claimAssignment,
  createMission,
  getAssignments,
  getMissionProjection,
  readMissionEvents,
} = await import("../lib/event-store.ts");
const { projectMission } = await import("../lib/mission-events.ts");
const { createCheckoutMessage, SERVICEPILOT_PLANS } = await import("../lib/servicepilot-preview.ts");

test.after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

test("the append-only event stream rebuilds every completed mission projection", async () => {
  const created = await createMission({
    objective: "Launch Stripe Billing for ServicePilot",
    deadline: "Today",
    priority: "High",
  });

  while (true) {
    const appended = await appendNextControlledEvent(created.id);
    if (!appended) break;
  }
  const approved = await approveRecommendation(created.id);
  assert.equal(approved?.type, "recommendation.approved");
  while (await appendNextControlledEvent(created.id)) {
    // Append controlled events until the real bounded assignment is created.
  }
  const assignmentEvents = await readMissionEvents(created.id);
  const assignment = getAssignments(assignmentEvents, "hermes")[0];
  assert.equal(assignment?.subject?.id, "task-servicepilot-pricing");
  await claimAssignment(created.id, "task-servicepilot-pricing", "hermes");
  for (const [type, message] of [
    ["artifact.created", "Annual pricing artifact produced"],
    ["check.completed", "Pricing validation passed"],
    ["task.completed", "Codex pricing task completed"],
    ["preview.ready", "Controlled checkout preview ready"],
    ["mission.completed", "Mission complete"],
  ]) {
    await appendAgentEvent({
      schemaVersion: "1.0", eventId: `${created.id}:${type}`, missionId: created.id,
      type, occurredAt: new Date().toISOString(), producer: { kind: "agent", id: "hermes", label: "Hermes" },
      correlationId: created.id, data: {
        message,
        ...(type === "artifact.created" ? { artifact: { kind: "git_diff", path: "src/pricing-plans.ts", summary: "Added Growth Annual", provenance: "live" } } : {}),
      },
    });
  }

  const canonicalEvents = await readMissionEvents(created.id);
  const liveProjection = await getMissionProjection(created.id);
  const rebuiltProjection = projectMission(JSON.parse(JSON.stringify(canonicalEvents)));

  assert.equal(canonicalEvents.length, 19);
  assert.equal(liveProjection?.completed, true);
  assert.deepEqual(rebuiltProjection, liveProjection);
  assert.equal(rebuiltProjection.previewReady, true);
  assert.deepEqual(rebuiltProjection.checks, ["Pricing validation passed"]);

  const persistedLines = (await readFile(path.join(dataDir, `${created.id}.jsonl`), "utf8")).trim().split("\n");
  assert.equal(persistedLines.length, canonicalEvents.length);
});

test("Hermes derives and claims its assignment exactly once from canonical events", async () => {
  const created = await createMission({ objective: "Hermes assignment", deadline: "Today", priority: "High" });
  while (true) {
    const next = await appendNextControlledEvent(created.id);
    if (!next || next.type === "recommendation.triggered") break;
  }
  await approveRecommendation(created.id);
  await appendNextControlledEvent(created.id);
  await appendNextControlledEvent(created.id);
  const beforeClaim = getAssignments(await readMissionEvents(created.id), "hermes");
  assert.equal(beforeClaim.length, 1);
  const [first, second] = await Promise.all([
    claimAssignment(created.id, "task-servicepilot-pricing", "hermes"),
    claimAssignment(created.id, "task-servicepilot-pricing", "hermes"),
  ]);
  assert.deepEqual(second, first);
  assert.equal(getAssignments(await readMissionEvents(created.id), "hermes").length, 0);
});

test("refresh reconstruction reads the same mission without appending events", async () => {
  const created = await createMission({ objective: "Refresh-safe mission", deadline: "Today", priority: "Normal" });
  await appendNextControlledEvent(created.id);
  await appendNextControlledEvent(created.id);

  const before = await readMissionEvents(created.id);
  const firstRefresh = await getMissionProjection(created.id);
  const secondRefresh = await getMissionProjection(created.id);
  const after = await readMissionEvents(created.id);

  assert.deepEqual(secondRefresh, firstRefresh);
  assert.deepEqual(after, before);
  assert.equal(after.length, 3);
});

test("event ids make canonical append idempotent", async () => {
  const created = await createMission({ objective: "Idempotent mission", deadline: "Today", priority: "Low" });
  const template = {
    type: "check.completed",
    producer: { kind: "platform", id: "test", label: "Test" },
    data: { message: "Idempotent check" },
  };

  const first = await appendMissionEvent(created.id, template, { eventId: "evt-idempotent" });
  const second = await appendMissionEvent(created.id, template, { eventId: "evt-idempotent" });
  const events = await readMissionEvents(created.id);

  assert.deepEqual(second, first);
  assert.equal(events.filter((event) => event.eventId === "evt-idempotent").length, 1);
});

test("concurrent controlled advances cannot duplicate mission progress", async () => {
  const created = await createMission({ objective: "Concurrent mission", deadline: "Today", priority: "High" });

  const [first, second] = await Promise.all([
    appendNextControlledEvent(created.id),
    appendNextControlledEvent(created.id),
  ]);
  const events = await readMissionEvents(created.id);

  assert.deepEqual(second, first);
  assert.equal(events.length, 2);
  assert.equal(events.at(-1)?.type, "plan.created");
});

test("the controlled preview produces checkout evidence for every plan", () => {
  for (const plan of SERVICEPILOT_PLANS) {
    assert.equal(createCheckoutMessage(plan.name), `${plan.name} subscription is ready for Stripe test-mode checkout.`);
  }
});

test("the controlled preview exposes the verified annual Growth artifact", () => {
  assert.deepEqual(
    SERVICEPILOT_PLANS.find((plan) => plan.name === "Growth Annual"),
    { name: "Growth Annual", price: "$490", interval: "year", detail: "Annual billing for growing operations" },
  );
});

test("the controlled preview rejects an unknown plan", () => {
  assert.throws(() => createCheckoutMessage("Enterprise"), /Unknown ServicePilot plan/);
});
