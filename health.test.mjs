import assert from "node:assert/strict";
import test from "node:test";
import { healthCheck } from "./health.mjs";

test("health check includes service metadata", () => {
  assert.deepEqual(healthCheck(), { status: "ok", service: "sample-app" });
});
