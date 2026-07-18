import assert from "node:assert/strict";
import test from "node:test";

import { createHealthResponse } from "./health.ts";

test("health response includes generatedAt metadata", () => {
  const before = Date.now();
  const response = createHealthResponse();
  const after = Date.now();
  const generatedAt = Date.parse(response.generatedAt);

  assert.equal(response.status, "ok");
  assert.equal(response.eventStore, process.env.EVENT_STORE ?? "jsonl");
  assert.match(response.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(generatedAt >= before && generatedAt <= after);
});
