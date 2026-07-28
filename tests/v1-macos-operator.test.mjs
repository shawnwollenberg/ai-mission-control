import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendV1OperatorJournal,
  completeV1OperatorJournal,
  createV1OperatorRequest,
  emptyV1OperatorJournal,
  verifyV1OperatorJournal,
  verifyV1OperatorRequest,
  readV1OperatorJournal,
  writeV1OperatorJournal,
} from "../application/v1-macos-operator-journal.ts";
import { createV1OperatorGrant, verifyV1OperatorGrant } from "../application/v1-macos-operator-grant.ts";
import { executeV1OperatorRequest } from "../application/v1-macos-operator.ts";

const key = "operator-acceptance-key-material-32-bytes-minimum";
const digest = (character) => character.repeat(64);
const binding = {
  authorizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  executionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  agentId: "0bd16e0e-98aa-4ab8-896a-f95d82ee5ad8",
  targetArtifactSha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
  priorInventorySha256: digest("1"),
  authorizationFingerprint: digest("2"),
  fencingGeneration: 7,
  operatorId: "11111111-1111-4111-8111-111111111111",
  missionControlDeploymentId: "ecs-svc/123",
  rollbackObligationId: "66666666-6666-4666-8666-666666666666",
};
const initialJournal = emptyV1OperatorJournal(binding, key);
const forward = createV1OperatorRequest(
  {
    ...binding,
    currentControllerDeploymentId: "ecs-svc/123",
    currentControllerFencingGeneration: 7,
    grantId: "12121212-1212-4212-8212-121212121212",
    grantChecksum: digest("3"),
    operation: "stage_artifact",
    providerMutationId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    requestMessageId: "33333333-3333-4333-8333-333333333333",
    nonce: "operator-nonce-1",
    issuedAt: "2026-07-27T17:59:00.000Z",
    forwardExpiresAt: "2026-07-27T18:05:00.000Z",
    expectedJournalChecksum: initialJournal.journalChecksum,
  },
  key,
);

test("v1 operator request binds every immutable execution identity", () => {
  verifyV1OperatorRequest(forward, key, binding, new Date("2026-07-27T18:00:00.000Z"));
  for (const changed of [
    { agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    { targetArtifactSha256: digest("f") },
    { fencingGeneration: 8 },
    { missionControlDeploymentId: "ecs-svc/other" },
    { currentControllerDeploymentId: "ecs-svc/other" },
    { currentControllerFencingGeneration: 8 },
  ])
    assert.throws(
      () => verifyV1OperatorRequest({ ...forward, ...changed }, key, binding, new Date("2026-07-27T18:00:00.000Z")),
      /binding|authentication/i,
    );
});

test("forward expiry fails closed while exact rollback obligation remains usable", () => {
  assert.throws(() => verifyV1OperatorRequest(forward, key, binding, new Date("2026-07-27T18:06:00.000Z")), /expired/i);
  const rollback = createV1OperatorRequest(
    {
      ...binding,
      currentControllerDeploymentId: "ecs-svc/123",
      currentControllerFencingGeneration: 7,
      grantId: "13131313-1313-4313-8313-131313131313",
      grantChecksum: digest("4"),
      operation: "restore_previous_version",
      providerMutationId: "44444444-4444-4444-8444-444444444444",
      sequence: 1,
      lifecycleSequence: 5,
      requestMessageId: "55555555-5555-4555-8555-555555555555",
      nonce: "operator-rollback-nonce",
      issuedAt: "2026-07-28T17:59:00.000Z",
      forwardExpiresAt: "2026-07-27T18:05:00.000Z",
      rollbackObligationId: binding.rollbackObligationId,
      expectedJournalChecksum: initialJournal.journalChecksum,
    },
    key,
  );
  verifyV1OperatorRequest(rollback, key, binding, new Date("2026-07-28T18:00:00.000Z"));
  assert.throws(
    () =>
      verifyV1OperatorRequest(
        { ...rollback, rollbackObligationId: undefined },
        key,
        binding,
        new Date("2026-07-28T18:00:00.000Z"),
      ),
    /authentication|obligation|binding/i,
  );
});

test("forward expiry is finite, ordered, and bounded to fifteen minutes", () => {
  for (const forwardExpiresAt of ["not-a-date", "2026-07-27T17:58:59.000Z", "2026-07-27T18:14:00.001Z"]) {
    const request = createV1OperatorRequest(
      {
        ...forward,
        forwardExpiresAt,
        requestAuthenticationTag: undefined,
      },
      key,
    );
    assert.throws(
      () => verifyV1OperatorRequest(request, key, binding, new Date("2026-07-27T18:00:00.000Z")),
      /malformed|contradictory/i,
    );
  }
});

test("only an exact durable intent may recover after request and forward expiry", () => {
  const journal = appendV1OperatorJournal(initialJournal, forward, "intent_recorded", key);
  verifyV1OperatorRequest(forward, key, binding, new Date("2026-07-28T18:00:00.000Z"), {
    allowExactIntentRecovery:
      journal.entries[0].requestChecksum ===
      createHash("sha256")
        .update(
          JSON.stringify(
            Object.fromEntries(
              Object.entries(forward)
                .filter(([name]) => name !== "requestAuthenticationTag")
                .sort(([a], [b]) => a.localeCompare(b)),
            ),
          ),
        )
        .digest("hex"),
  });
  const contradictory = createV1OperatorRequest(
    {
      ...forward,
      providerMutationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      requestAuthenticationTag: undefined,
    },
    key,
  );
  assert.throws(
    () => verifyV1OperatorRequest(contradictory, key, binding, new Date("2026-07-28T18:00:00.000Z")),
    /malformed|expired/i,
  );
});

test("journal is authenticated, hash chained, idempotent, and receipt recoverable", () => {
  let journal = initialJournal;
  journal = appendV1OperatorJournal(journal, forward, "intent_recorded", key, undefined, "2026-07-27T18:00:00.000Z");
  const duplicate = appendV1OperatorJournal(
    journal,
    forward,
    "intent_recorded",
    key,
    undefined,
    "2026-07-27T18:00:01.000Z",
  );
  assert.equal(duplicate.journalChecksum, journal.journalChecksum);
  journal = completeV1OperatorJournal(journal, forward, digest("9"), key, "2026-07-27T18:00:02.000Z");
  verifyV1OperatorJournal(journal, key);
  assert.equal(journal.entries[0].status, "completed");
  assert.equal(journal.entries[0].providerReceiptChecksum, digest("9"));
  assert.throws(() =>
    verifyV1OperatorJournal({ ...journal, entries: [{ ...journal.entries[0], nonce: "tampered" }] }, key),
  );
});

test("nonce, message, provider mutation, and sequence replay fail closed", () => {
  const journal = appendV1OperatorJournal(initialJournal, forward, "intent_recorded", key);
  for (const changed of [
    { providerMutationId: forward.providerMutationId, requestMessageId: "77777777-7777-4777-8777-777777777777" },
    { nonce: forward.nonce, providerMutationId: "88888888-8888-4888-8888-888888888888" },
    { sequence: 3, providerMutationId: "99999999-9999-4999-8999-999999999999" },
  ]) {
    const value = createV1OperatorRequest({ ...forward, ...changed, requestAuthenticationTag: undefined }, key);
    assert.throws(() => appendV1OperatorJournal(journal, value, "intent_recorded", key), /replay|successor/i);
  }
});

test("operator grant independently pins executable and execution identities", () => {
  const grant = createV1OperatorGrant(
    {
      schemaVersion: "mission-agent-v1-operator-grant-v1",
      grantId: "abababab-abab-4bab-8bab-abababababab",
      grantKind: "forward",
      binding,
      credentialId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      operationId: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      providerMutationId: forward.providerMutationId,
      sequence: 1,
      lifecycleSequence: 4,
      hostFingerprint: `ed25519-spki-sha256:${digest("b")}`,
      operatorArtifactSha256: digest("a"),
      operatorProtocolVersion: "1",
      configurationVersion: 4,
      originatingForwardDeploymentId: binding.missionControlDeploymentId,
      currentControllerDeploymentId: binding.missionControlDeploymentId,
      currentControllerFencingGeneration: binding.fencingGeneration,
      rollbackObligationId: binding.rollbackObligationId,
      approvedExecutableChecksum: digest("a"),
      allowedOperation: "stage_artifact",
      missionControlUrl: "https://mission-control.invalid",
      issuedAt: "2026-07-27T18:00:00.000Z",
      expiresAt: "2026-07-27T18:10:00.000Z",
    },
    key,
  );
  verifyV1OperatorGrant(grant, key, new Date("2026-07-27T18:05:00.000Z"));
  assert.throws(() => verifyV1OperatorGrant(grant, key, new Date("2026-07-27T18:10:00.000Z")));
  assert.throws(() => verifyV1OperatorGrant({ ...grant, approvedExecutableChecksum: digest("b") }, key));
});

test("journal persistence recovers a stale temp file and preserves authenticated head", async () => {
  const root = await mkdtemp(join(tmpdir(), "v1-operator-journal-"));
  const path = join(root, "journal.json");
  await writeFile(`${path}.tmp`, "partial");
  await writeV1OperatorJournal(path, initialJournal);
  const recovered = await readV1OperatorJournal(path, key);
  assert.equal(recovered.journalChecksum, initialJournal.journalChecksum);
  assert.doesNotMatch(await readFile(path, "utf8"), /partial/);
});

test("host provider rejects control-plane-only vocabulary before any boundary or provider action", async () => {
  const request = createV1OperatorRequest(
    {
      ...binding,
      currentControllerDeploymentId: "ecs-svc/123",
      currentControllerFencingGeneration: 7,
      grantId: "14141414-1414-4414-8414-141414141414",
      grantChecksum: digest("5"),
      operation: "request_drain",
      providerMutationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      sequence: 1,
      requestMessageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      nonce: "control-plane-only",
      issuedAt: "2026-07-27T18:00:00.000Z",
      forwardExpiresAt: "2026-07-27T18:05:00.000Z",
      expectedJournalChecksum: initialJournal.journalChecksum,
    },
    key,
  );
  let providerTouched = false;
  await assert.rejects(
    () =>
      executeV1OperatorRequest({
        request,
        expectedBinding: binding,
        credentialKey: key,
        boundary: {
          executablePath: "/forbidden",
          executableChecksum: digest("a"),
          expectedUid: 501,
          actualUid: 501,
          platform: "darwin",
          journalPath: "/forbidden",
        },
        provider: {
          async inspect() {
            providerTouched = true;
            return "postcondition";
          },
          async execute() {
            throw new Error("unreachable");
          },
          async verify() {
            throw new Error("unreachable");
          },
        },
        async confirmWithControlPlane() {
          throw new Error("unreachable");
        },
        now: new Date("2026-07-27T18:01:00.000Z"),
      }),
    /not a host-provider operation/i,
  );
  assert.equal(providerTouched, false);
});

function resultChecksum(request, observations) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        providerMutationId: request.providerMutationId,
        operation: request.operation,
        observations,
      }),
    )
    .digest("hex");
}

test("durable authenticated receipt recovers a post-mutation crash without duplicate execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "v1-operator-execute-"));
  const journalPath = join(root, "journal.json");
  let executions = 0;
  const provider = {
    async inspect() {
      return executions === 0 ? "precondition" : "postcondition";
    },
    async execute(request) {
      executions += 1;
      const observations = [{ installed: true }];
      return {
        providerMutationId: request.providerMutationId,
        operation: request.operation,
        startedAt: "2026-07-27T18:00:00.000Z",
        completedAt: "2026-07-27T18:00:01.000Z",
        resultChecksum: resultChecksum(request, observations),
        safeSummary: "disposable mutation complete",
        observations,
      };
    },
    async verify() {
      throw new Error("receipt recovery must precede provider inspection");
    },
  };
  const common = {
    request: forward,
    expectedBinding: binding,
    credentialKey: key,
    boundary: {
      executablePath: "/disposable/operator-v1.mjs",
      executableChecksum: digest("a"),
      expectedUid: 501,
      actualUid: 501,
      platform: "darwin",
      journalPath,
    },
    provider,
    async assertRuntimeBoundary() {},
    async confirmWithControlPlane({ journalChecksum }) {
      return { accepted: true, currentJournalChecksum: journalChecksum };
    },
  };
  await assert.rejects(
    () =>
      executeV1OperatorRequest({
        ...common,
        now: new Date("2026-07-27T18:01:00.000Z"),
        async afterReceiptPersisted() {
          throw new Error("simulated process interruption");
        },
      }),
    /simulated process interruption/,
  );
  assert.equal(executions, 1);
  const recovered = await executeV1OperatorRequest({
    ...common,
    now: new Date("2026-07-28T18:01:00.000Z"),
  });
  assert.equal(recovered.disposition, "receipt_recovered");
  assert.equal(executions, 1);
});

test("forged predictable receipt cannot suppress a host mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "v1-operator-forged-receipt-"));
  const journalPath = join(root, "journal.json");
  const receiptDirectory = join(root, "receipts");
  await mkdir(receiptDirectory, { recursive: true });
  const observations = [{ installed: false }];
  await writeFile(
    join(receiptDirectory, `${forward.providerMutationId}.json`),
    `${JSON.stringify({
      providerMutationId: forward.providerMutationId,
      operation: forward.operation,
      startedAt: "2026-07-27T18:00:00.000Z",
      completedAt: "2026-07-27T18:00:01.000Z",
      resultChecksum: resultChecksum(forward, observations),
      safeSummary: "forged",
      observations,
    })}\n`,
  );
  let providerTouched = false;
  await assert.rejects(
    () =>
      executeV1OperatorRequest({
        request: forward,
        expectedBinding: binding,
        credentialKey: key,
        boundary: {
          executablePath: "/disposable/operator-v1.mjs",
          executableChecksum: digest("a"),
          expectedUid: 501,
          actualUid: 501,
          platform: "darwin",
          journalPath,
        },
        provider: {
          async inspect() {
            providerTouched = true;
            return "precondition";
          },
          async execute() {
            throw new Error("unreachable");
          },
          async verify() {
            throw new Error("unreachable");
          },
        },
        async assertRuntimeBoundary() {},
        async confirmWithControlPlane({ journalChecksum }) {
          return { accepted: true, currentJournalChecksum: journalChecksum };
        },
        now: new Date("2026-07-27T18:01:00.000Z"),
      }),
    /unauthenticated|contradicts/i,
  );
  assert.equal(providerTouched, false);
});
