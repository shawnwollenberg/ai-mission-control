import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ValidationFailedError } from "../lib/application-errors";
import { serializeApplicationError } from "../lib/http-errors.ts";

const reasons = ["ASSIGNMENT_LEASE_LOST", "DELAYED_PROVIDER_OUTPUT_REJECTED", "CONFLICTING_RECEIPT_REJECTED"];

test("validation_failed preserves stable reason details through API serialization", async () => {
  for (const reason_code of reasons) {
    const body = serializeApplicationError(
      new ValidationFailedError("stable human message", { reason_code }),
      "00000000-0000-4000-8000-000000000001",
    );
    assert.equal(body.error.code, "validation_failed");
    assert.equal(body.error.details.reason_code, reason_code);
    assert.doesNotMatch(JSON.stringify(body), /leaseToken|credential|secret/i);
  }
});

test("unrelated validation failures receive no recovery reason code", async () => {
  const body = serializeApplicationError(
    new ValidationFailedError("unrelated"),
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(body.error.code, "validation_failed");
  assert.equal(body.error.details, undefined);
});

test("authoritative command boundaries emit reasons and acceptance does not infer them from messages", async () => {
  const lease = await readFile(new URL("../application/pull-assignments.ts", import.meta.url), "utf8");
  const messages = await readFile(new URL("../application/remote-agent-messages.ts", import.meta.url), "utf8");
  const harness = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  assert.match(lease, /reason_code:\s*"ASSIGNMENT_LEASE_LOST"/);
  assert.match(messages, /reason_code:\s*"DELAYED_PROVIDER_OUTPUT_REJECTED"/);
  assert.match(messages, /reason_code:\s*"CONFLICTING_RECEIPT_REJECTED"/);
  assert.doesNotMatch(harness, /includes\([^)]*(lease is invalid|delayed provider output|receipt does not match)/i);
});
