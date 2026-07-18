import assert from "node:assert/strict";
import test from "node:test";

import { health } from "./health.mjs";

test("health includes service policy metadata", () => {
  assert.deepEqual(health(), {
    status: "ok",
    service: "sample-app",
    policyVersion: "phase3.1",
  });
});
