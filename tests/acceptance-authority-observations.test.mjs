import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AUTHORITY_OBSERVATION_DEFINITIONS } from "../lib/acceptance-authority-observations.ts";
import { presentationAuthorityScenarios } from "../lib/acceptance-authority-presentation-scenarios.ts";
import { authorityPresentationAcceptanceTrustEnabled } from "../application/acceptance-authority-presentation-observations.ts";
import { governedApplicationError } from "../application/acceptance-authority-presentation-observations.ts";

const trust = (overrides = {}) => ({
  schemaVersion: "mission-control-runtime-trust/1",
  runtimeMode: "disposable_acceptance",
  disposable: true,
  trustAuthority: "disposable_exact_checksum_registry",
  registryPath: "/private/tmp/acceptance/registry.json",
  registryPathHash: "a".repeat(64),
  registryContentHash: "b".repeat(64),
  registryVersion: "mission-agent-disposable-acceptance/2",
  registryScope: "consensus_real_provider_acceptance",
  registryExpiresAt: "2099-01-01T00:00:00.000Z",
  databaseIdentity: "c".repeat(64),
  productionResourcesAllowed: false,
  ...overrides,
});

test("authority registry enumerates eleven requirement-specific governed scenarios", () => {
  assert.equal(AUTHORITY_OBSERVATION_DEFINITIONS.length, 11);
  assert.equal(new Set(AUTHORITY_OBSERVATION_DEFINITIONS.map(([requirement]) => requirement)).size, 11);
  assert.deepEqual(
    presentationAuthorityScenarios.slice(0, 7).map(([requirement, mutation]) => [requirement, mutation]),
    AUTHORITY_OBSERVATION_DEFINITIONS.slice(0, 7).map(([requirement, mutation]) => [requirement, mutation]),
  );
  assert.deepEqual(presentationAuthorityScenarios.at(-1)?.slice(0, 2), [
    "authority.stale_provider_attempt_rejected",
    "provider_attempt",
  ]);
});

test("authority adversarial evidence is enabled only for exact governed acceptance trust", () => {
  assert.equal(
    authorityPresentationAcceptanceTrustEnabled({
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: "consensus_real_provider_acceptance",
      trust: trust(),
    }),
    true,
  );
  assert.equal(
    authorityPresentationAcceptanceTrustEnabled({
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: "mock_provider_acceptance",
      trust: trust({
        trustAuthority: "non_authenticated_candidate_validation",
        registryVersion: "mission-agent-non-authenticated-candidate-validation/1",
        registryScope: "non_authenticated_candidate_validation",
      }),
    }),
    true,
  );
  for (const input of [
    { appEnvironment: "production", providerRuntimeMode: "consensus_real_provider_acceptance", trust: trust() },
    {
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: "consensus_real_provider_acceptance",
      trust: trust({ productionResourcesAllowed: true }),
    },
    {
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: undefined,
      trust: trust(),
    },
    {
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: "consensus_real_provider_acceptance",
      trust: trust({ registryScope: "non_authenticated_candidate_validation" }),
    },
    {
      appEnvironment: "disposable_acceptance",
      providerRuntimeMode: "consensus_real_provider_acceptance",
      trust: trust({ registryContentHash: "changed", trustAuthority: "non_release_runtime" }),
    },
  ])
    assert.equal(authorityPresentationAcceptanceTrustEnabled(input), false);
});

test("authority rejection markers accept exact structural application errors across module boundaries", () => {
  const structural = {
    code: "validation_failed",
    message: "Execution authority runtime profile does not match",
    details: { reason_code: "ASSIGNMENT_RUNTIME_PROFILE_CHANGED" },
  };
  assert.deepEqual(governedApplicationError(structural), structural);
  assert.equal(governedApplicationError({ ...structural, code: "unknown_error" }), undefined);
  assert.equal(governedApplicationError({ ...structural, message: 23 }), undefined);
  assert.equal(governedApplicationError({ ...structural, details: [] }), undefined);
  assert.equal(governedApplicationError(new Error("unclassified")), undefined);
});

test("the server derives authenticated acceptance mode only from exact disposable registry trust", async () => {
  const source = await readFile(
    new URL("../application/acceptance-authority-presentation-observations.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /trust\.trustAuthority === "disposable_exact_checksum_registry"/);
  assert.match(source, /trust\.registryScope === "consensus_real_provider_acceptance"/);
  assert.match(source, /\? "consensus_real_provider_acceptance"\s*: undefined/);
  assert.match(source, /catch \{\s*return false;/);
});

test("presentation observations come from the active production route and persisted before/after state", async () => {
  const source = await readFile(new URL("../lib/acceptance-authority-observations.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /generateAcceptanceAuthorityObservations|rejectionCode\s*\(|durableStateAfterSha256/);
  const executor = await readFile(
    new URL("../lib/acceptance-authority-presentation-scenarios.ts", import.meta.url),
    "utf8",
  );
  assert.match(executor, /acceptance_authority_presentation_observations/);
  assert.match(executor, /ACTIVE_PRESENTATION_ROUTE_IDENTITY/);
  assert.match(executor, /row\.assignment_status !== "acknowledged"/);
  assert.match(executor, /canonicalHash\(before\) !== canonicalHash\(after\)/);
  assert.doesNotMatch(executor, /validateExecutionAuthorityPresentation/);
  const route = await readFile(new URL("../app/api/agent-protocol/v1/messages/route.ts", import.meta.url), "utf8");
  assert.ok(route.indexOf("acquireExecutionLeaseFence") < route.indexOf("scenario.baselinePresentation"));
  assert.match(route, /recordActivePresentationRejection/);
  const agent = await readFile(new URL("../scripts/mission-agent-080.template.mjs", import.meta.url), "utf8");
  assert.match(agent, /acceptanceAuthorityPresentationScenario/);
  assert.match(
    agent,
    /const executionAuthorityPresentationSha256[\s\S]*?\["mock_provider_acceptance", "consensus_real_provider_acceptance"\]\.includes\([\s\S]*?acceptanceAuthorityPresentationScenario/,
  );
  assert.match(
    agent,
    /\["mock_provider_acceptance", "consensus_real_provider_acceptance"\]\.includes\([\s\S]*?await heartbeat\(config\);[\s\S]*?stage: "provider_attempt_authority_bound"/,
  );
  assert.match(agent, /classifyExpectedGovernedRejection\(rejection, requirementId, expectedReasonCode\)/);
  assert.match(
    agent,
    /error\?\.code === "validation_failed"[\s\S]*?error\?\.details\?\.reason_code === expectedReasonCode/,
  );
  assert.match(agent, /acceptance_scenario_baseline_valid === true/);
  assert.match(agent, /acceptance_scenario_rejection_recorded === true/);
  assert.match(route, /acceptance_scenario_baseline_valid: true/);
  assert.match(route, /acceptance_scenario_rejection_recorded: true/);
  assert.match(route, /const recordedApplicationError = await recordActivePresentationRejection/);
  assert.match(route, /if \(recordedApplicationError\)/);
  assert.doesNotMatch(route, /recorded[^\n]*error instanceof ApplicationError/);
  const observationRecorder = await readFile(
    new URL("../application/acceptance-authority-presentation-observations.ts", import.meta.url),
    "utf8",
  );
  assert.match(observationRecorder, /return error;/);
  assert.doesNotMatch(observationRecorder, /input\.error instanceof ApplicationError/);
});

test("authenticated Mission Agent execution receives the explicit real-provider acceptance mode", async () => {
  const harness = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  assert.match(
    harness,
    /MISSION_AGENT_PROVIDER_RUNTIME_MODE: mockProviderValidation\s*\? "mock_provider_acceptance"\s*: "consensus_real_provider_acceptance"/,
  );
});

test("the normal completion boundary requires an active lease under the assignment authority fence", async () => {
  const source = await readFile(new URL("../application/remote-agent-messages.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/agent-protocol/v1/messages/route.ts", import.meta.url), "utf8");
  assert.match(source, /\["leased", "acknowledged"\]\.includes\(authority\.assignment_status\)/);
  assert.match(source, /authority\.lease_expires_at/);
  assert.ok(
    source.indexOf('"ASSIGNMENT_EXECUTABLE_BINDING_CHANGED"') <
      source.indexOf('"Execution authority lease is not active"'),
  );
  assert.match(route, /releaseExecutionFence = await acquireExecutionLeaseFence/);
  assert.match(route, /const result = await processAuthenticatedMessage/);
  assert.match(route, /finally \{\s*await releaseExecutionFence\?\.\(\)/s);
  assert.match(source, /Reacquiring the same session lock from a\s*\/\/ second pool connection would self-deadlock/);
  assert.match(source, /persistConsensusValidationReceiptWithAuthorityFence\(message, credential\)/);
});
