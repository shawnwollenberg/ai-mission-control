import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { requireWorkerAuthentication } from "../v2/worker/auth.ts";
import { parseWorkerPid, resolveWorkerPid } from "../v2/worker/process-state.ts";

test("worker authentication accepts only the exact configured bearer token", { concurrency: false }, () => {
  const previous = process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256;
  const token = "bounded-test-worker-token";
  try {
    process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256 = createHash("sha256").update(token).digest("hex");
    assert.doesNotThrow(() =>
      requireWorkerAuthentication(
        new Request("https://mission-control.test", { headers: { authorization: `Bearer ${token}` } }),
      ),
    );
    assert.throws(
      () =>
        requireWorkerAuthentication(
          new Request("https://mission-control.test", { headers: { authorization: "Bearer wrong-token" } }),
        ),
      /WORKER_UNAUTHORIZED/,
    );
    assert.throws(
      () => requireWorkerAuthentication(new Request("https://mission-control.test")),
      /WORKER_UNAUTHORIZED/,
    );
    delete process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256;
    assert.throws(
      () => requireWorkerAuthentication(new Request("https://mission-control.test")),
      /WORKER_AUTH_NOT_CONFIGURED/,
    );
  } finally {
    if (previous === undefined) delete process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256;
    else process.env.MISSION_CONTROL_V2_WORKER_TOKEN_SHA256 = previous;
  }
});

test("worker PID reconciliation prefers a live direct process and repairs a stale wrapper PID", () => {
  assert.equal(parseWorkerPid("56341\n"), 56341);
  assert.equal(parseWorkerPid("not-a-pid"), undefined);
  assert.equal(parseWorkerPid("1"), undefined);
  assert.equal(
    resolveWorkerPid({ recordedPid: 100, lockPid: 200, isAlive: (value) => value === 200 }),
    200,
    "the worker-owned lock PID replaces a stale launcher PID",
  );
  assert.equal(
    resolveWorkerPid({ recordedPid: 100, lockPid: 200, isAlive: (value) => value === 100 || value === 200 }),
    100,
    "a live direct recorded PID remains authoritative",
  );
  assert.equal(resolveWorkerPid({ recordedPid: 100, lockPid: 200, isAlive: () => false }), undefined);
});
