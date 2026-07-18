import assert from "node:assert/strict";
import test from "node:test";
import { calculateAgentHealth } from "../application/agent-eligibility.ts";

function agent(overrides = {}) {
  return {
    status: "active",
    credential_status: "active",
    last_heartbeat_at: new Date("2026-07-18T12:00:00.000Z"),
    concurrency_limit: 2,
    capabilities: [],
    supported_domains: [],
    protocol_versions: ["1.0"],
    current_executions: 0,
    delivery_failures: 0,
    execution_failures: 0,
    protocol_failures: 0,
    trust_level: "standard",
    cost_metadata: {},
    valid_credentials: 1,
    ...overrides,
  };
}

const now = Date.parse("2026-07-18T12:00:00.000Z");

test("health is derived from Mission Control evidence and configurable thresholds", () => {
  process.env.REMOTE_AGENT_HEARTBEAT_INTERVAL_MS = "30000";
  process.env.REMOTE_AGENT_OFFLINE_MS = "300000";
  assert.equal(calculateAgentHealth(agent(), now).status, "active");
  assert.equal(calculateAgentHealth(agent({ last_heartbeat_at: new Date(now - 61_000) }), now).status, "degraded");
  assert.equal(calculateAgentHealth(agent({ last_heartbeat_at: new Date(now - 121_000) }), now).status, "stale");
  assert.equal(calculateAgentHealth(agent({ last_heartbeat_at: new Date(now - 301_000) }), now).status, "offline");
});

test("credentials, failures, saturation, and manual disablement affect health", () => {
  assert.equal(calculateAgentHealth(agent({ valid_credentials: 0 }), now).status, "offline");
  assert.equal(calculateAgentHealth(agent({ protocol_failures: 1 }), now).status, "degraded");
  assert.equal(calculateAgentHealth(agent({ current_executions: 2 }), now).status, "degraded");
  assert.equal(calculateAgentHealth(agent({ status: "disabled" }), now).status, "disabled");
});
