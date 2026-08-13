import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import dns from "node:dns";
import net from "node:net";

const artifactPath =
  "/tmp/mission-control-runtime-v6-local-validation/mission-agent-0.8.0-runtime-v6-local-validation.mjs";
const authorizationPath =
  "/tmp/mission-control-runtime-v6-local-validation/non-authenticated-candidate-validation.json";
const authorization = JSON.parse(await readFile(authorizationPath, "utf8"));
const authorizationSha256 = createHash("sha256")
  .update(await readFile(authorizationPath))
  .digest("hex");
Object.assign(process.env, {
  APP_ENV: "disposable_acceptance",
  CONSENSUS_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
  MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
  MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION: authorizationPath,
  MISSION_CONTROL_LOCAL_VALIDATION_AUTHORIZATION_SHA256: authorizationSha256,
  MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION: authorizationPath,
  MISSION_AGENT_MOCK_VALIDATION_AUTHORIZATION_SHA256: authorizationSha256,
  MISSION_AGENT_MOCK_RUNTIME_PATH: new URL("../scripts/mock-provider-runtime.mjs", import.meta.url).pathname,
  CONSENSUS_ACCEPTANCE_ARTIFACT: artifactPath,
  DISPOSABLE_ACCEPTANCE_PROVIDER_WRITABLE_ROOTS: "[]",
  DISPOSABLE_ACCEPTANCE_DATABASE_NAME: "mc_disposable_acceptance_resource_authority",
  DATABASE_URL: "postgresql://mission_control@127.0.0.1:5432/mc_disposable_acceptance_resource_authority",
});
const { evaluateResourceAuthority, observeProductionResourceRejection } =
  await import("../application/resource-authority.ts");
const { producePreReviewEvidence, validateProducedPreReviewEvidence } =
  await import("../lib/acceptance-pre-review-producers.ts");

const request = (classification = "production") => ({
  commandId: randomUUID(),
  acceptanceRunId: randomUUID(),
  candidateIdentitySha256: authorization.artifact.sha256,
  workspaceId: "",
  missionId: null,
  actorId: "focused-acceptance",
  resourceType: "database",
  resourceClassification: classification,
  operation: "connect",
  resourceIdentity: "synthetic-production-db-fixture",
  requestedAt: new Date().toISOString(),
});

test("production classification rejects declaratively with stable reason and no contact", (t) => {
  const input = request();
  input.workspaceId = input.acceptanceRunId;
  const attempts = { dns: 0, socket: 0, database: 0, provider: 0, http: 0 };
  t.mock.method(dns, "lookup", () => {
    attempts.dns += 1;
    throw new Error("DNS forbidden");
  });
  t.mock.method(net, "connect", () => {
    attempts.socket += 1;
    throw new Error("socket forbidden");
  });
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts.http += 1;
    throw new Error("HTTP forbidden");
  };
  try {
    assert.throws(
      () => evaluateResourceAuthority(input),
      (error) => {
        assert.equal(error.code, "validation_failed");
        assert.equal(error.details.reason_code, "PRODUCTION_RESOURCE_FORBIDDEN");
        return true;
      },
    );
    assert.deepEqual(attempts, { dns: 0, socket: 0, database: 0, provider: 0, http: 0 });
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("disposable classification is allowed and unrelated invalid binding is discriminated", () => {
  const allowed = request("disposable");
  allowed.workspaceId = allowed.acceptanceRunId;
  assert.equal(evaluateResourceAuthority(allowed).decision, "allowed");
  assert.throws(
    () => evaluateResourceAuthority({ ...allowed, workspaceId: randomUUID() }),
    (error) => {
      assert.equal(error.code, "validation_failed");
      assert.equal(error.details, undefined);
      return true;
    },
  );
});

test("the orchestration observation comes from the governed command and passes its semantic validator", () => {
  const input = request();
  input.workspaceId = input.acceptanceRunId;
  const counters = {
    dnsResolutionAttempts: 0,
    socketConnectionAttempts: 0,
    databaseConnectionAttempts: 0,
    providerInvocationCount: 0,
    remoteHttpAttempts: 0,
  };
  const durableState = "a".repeat(64);
  const observation = observeProductionResourceRejection({
    request: input,
    counters: () => ({ ...counters }),
    durableStateIdentity: () => durableState,
  });
  const candidateBindings = Object.fromEntries(
    [
      "artifactSha256",
      "artifactMetadataSha256",
      "capabilityManifestSha256",
      "acceptanceSourceManifestSha256",
      "acceptanceContractSha256",
      "executableRegistrySha256",
      "disposableRegistrySha256",
      "providerRequirementsSha256",
      "providerProfilesSha256",
      "runtimeBindingsSha256",
      "modelAssignmentsSha256",
      "repositorySnapshotSha256",
      "validatorRegistrySha256",
      "reviewChecklistSha256",
      "finalizerChecklistSha256",
      "reviewerImplementationSha256",
      "resourceInventoryImplementationSha256",
      "cleanupFinalizerSha256",
      "realAcceptanceHarnessSha256",
    ].map((key) => [key, "b".repeat(64)]),
  );
  const context = {
    acceptanceRunId: input.acceptanceRunId,
    candidateBindings,
    observedAt: new Date().toISOString(),
  };
  const proof = producePreReviewEvidence(
    "isolation.production_resources_rejected",
    { isolation: { productionResourceRejection: observation } },
    context,
  );
  assert.deepEqual(validateProducedPreReviewEvidence("isolation.production_resources_rejected", proof, context), []);
  assert.equal(proof.observation.actualRejectionCode, "PRODUCTION_RESOURCE_FORBIDDEN");
  assert.equal(proof.observation.actualTopLevelErrorCode, "validation_failed");
});

test("authority primitive has no networking, database, provider, or HTTP dependencies", async () => {
  const source = await readFile(new URL("../application/resource-authority.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']node:(?:dns|net|http|https)["']/);
  assert.doesNotMatch(source, /getDatabasePool|fetch\(|invokeProvider|providerRuntime/);
});
