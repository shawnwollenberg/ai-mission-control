import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDisposableReplacementDependencies } from "../application/replacement-bootstrap-disposable.ts";
import {
  executeReplacementBootstrap,
  reconcileReplacementRecovery,
  recoverReplacementBootstrap,
  replacementPreflight,
} from "../application/replacement-bootstrap-operator.ts";
import {
  NAMED_CANARY_ID,
  REPLACEMENT_BOOTSTRAP_PROTOCOL,
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";

const fixture = JSON.parse(
  await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8"),
);
const now = new Date("2026-07-28T00:00:00.000Z");
const authorization = validateReplacementAuthorization(fixture, { now });

const execute = async (options = {}) => {
  const dependencies = await createDisposableReplacementDependencies(authorization, options);
  const evidence = await executeReplacementBootstrap({
    mode: "disposable",
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    acknowledge: REPLACEMENT_BOOTSTRAP_PROTOCOL,
    dependencies,
  });
  return { dependencies, evidence };
};

test("authorization fingerprint binds Node, service, smoke, and evidence fields", () => {
  const original = authorizationChecksum(authorization);
  for (const mutation of [
    { nodeRuntime: { ...authorization.nodeRuntime, archiveSha256: "b".repeat(64) } },
    { nodeRuntime: { ...authorization.nodeRuntime, installationDirectory: "/usr/local/node" } },
    { nodeRuntime: { ...authorization.nodeRuntime, executablePath: "node" } },
    { serviceReplacement: { ...authorization.serviceReplacement, targetDefinitionSha256: "b".repeat(64) } },
    { serviceReplacement: { ...authorization.serviceReplacement, targetDefinitionPath: "../agent.plist" } },
    { smokeMission: { ...authorization.smokeMission, readOnly: false } },
    { evidenceDestination: "/tmp/evidence.json" },
  ]) {
    const changed = { ...authorization, ...mutation };
    assert.notEqual(authorizationChecksum(changed), original);
    assert.throws(() => validateReplacementAuthorization(changed, { now }));
  }
  assert.throws(() => validateReplacementAuthorization({ ...authorization, unexpected: true }, { now }));
  assert.throws(() =>
    validateReplacementAuthorization(
      { ...authorization, nodeRuntime: { ...authorization.nodeRuntime, unexpected: true } },
      { now },
    ),
  );
});

test("dry-run preflight is machine-readable and mutation-free", async () => {
  const dependencies = await createDisposableReplacementDependencies(authorization);
  const { report } = await replacementPreflight({
    mode: "dry-run",
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  });
  assert.equal(report.mutationPerformed, false);
  assert.equal(report.authorizationChecksum, authorizationChecksum(authorization));
  assert.equal(dependencies.inspectState().operations.length, 0);
});

test("disposable success completes exactly one replacement and one read-only smoke", async () => {
  const { dependencies, evidence } = await execute();
  assert.equal(evidence.disposition, "completed");
  assert.equal(evidence.finalSnapshot.version, "0.7.2");
  assert.equal(evidence.finalSnapshot.runtimeVersion, "22.22.0");
  assert.equal(evidence.smoke?.readOnly, true);
  assert.equal(evidence.smoke?.projectionConsistent, true);
  assert.equal(dependencies.inspectState().state, "completed");
  assert.equal(dependencies.inspectState().operations.filter((item) => item === "atomic_switch").length, 1);
  assert.equal(dependencies.inspectState().operations.filter((item) => item === "start").length, 1);
});

test("post-start and smoke failures roll back exact 0.6.8 without retry", async () => {
  for (const failAt of ["verify_heartbeats", "smoke"]) {
    const { dependencies, evidence } = await execute({ failAt });
    assert.equal(evidence.disposition, "rolled_back");
    assert.equal(evidence.finalSnapshot.version, "0.6.8");
    assert.equal(evidence.finalSnapshot.artifactSha256, authorization.currentArtifactSha256);
    assert.equal(dependencies.inspectState().state, "rolled_back");
    assert.equal(dependencies.inspectState().operations.filter((item) => item === "atomic_switch").length, 1);
    assert.equal(dependencies.inspectState().operations.filter((item) => item === "restart_rollback").length, 1);
  }
});

test("operator negative matrix fails closed", async () => {
  const dependencies = await createDisposableReplacementDependencies(authorization);
  const base = {
    mode: "dry-run",
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  };
  await assert.rejects(() =>
    replacementPreflight({ ...base, authorizationId: "00000000-0000-4000-8000-000000000000" }),
  );
  await assert.rejects(() =>
    replacementPreflight({ ...base, assertedAgentId: "00000000-0000-4000-8000-000000000000" }),
  );
  await assert.rejects(() => replacementPreflight({ ...base, actor: "wrong-operator" }));
  await assert.rejects(() =>
    executeReplacementBootstrap({
      ...base,
      mode: "disposable",
      acknowledge: "wrong-protocol",
    }),
  );
});

test("every host-operation failure before mutation halts and after mutation rolls back", async () => {
  const beforeMutation = ["inventory", "verify_rollback", "drain", "stage_node", "stage_release", "stage_service"];
  for (const failAt of beforeMutation) await assert.rejects(() => execute({ failAt }));
  for (const failAt of [
    "stop",
    "atomic_switch",
    "start",
    "verify_identity",
    "verify_heartbeats",
    "verify_capabilities",
    "observe",
  ]) {
    const { evidence } = await execute({ failAt });
    assert.equal(evidence.disposition, "rolled_back");
  }
});

test("interruption matrix resumes only idempotent operations and rolls back after mutation", () => {
  const checksum = authorizationChecksum(authorization);
  const cases = [
    ["approved", null, "inventory", "resume"],
    ["approved", "inventory", "verify_rollback", "resume"],
    ["approved", "verify_rollback", "drain", "resume"],
    ["approved", "drain", "stage_node", "transition"],
    ["draining", "drain", "stage_node", "resume"],
    ["draining", "stage_node", "stage_release", "resume"],
    ["draining", "stage_release", "stage_service", "transition"],
    ["verified", "stage_release", "stage_service", "resume"],
    ["verified", "stage_service", "stop", "transition"],
    ["staged", "stage_service", "stop", "transition"],
    ["replacing", "stage_service", "stop", "resume"],
    ["replacing", "stop", "atomic_switch", "rollback"],
    ["starting", "atomic_switch", "start", "rollback"],
  ];
  for (const [databaseState, lastCompletedOperation, nextSafeOperation, action] of cases) {
    const result = reconcileReplacementRecovery({
      databaseState,
      expectedAuthorizationChecksum: checksum,
      journal: {
        authorizationChecksum: checksum,
        lastCompletedOperation,
        nextSafeOperation,
        rollbackAvailable: true,
        checksumValid: true,
      },
    });
    assert.equal(result.action, action);
  }
  assert.equal(
    reconcileReplacementRecovery({
      databaseState: "staged",
      expectedAuthorizationChecksum: checksum,
      journal: {
        authorizationChecksum: "b".repeat(64),
        lastCompletedOperation: "stage_service",
        nextSafeOperation: "stop",
        rollbackAvailable: true,
        checksumValid: true,
      },
    }).action,
    "halt",
  );
});

test("a new operator process reconciles an interrupted atomic switch and rolls back", async () => {
  const dependencies = await createDisposableReplacementDependencies(authorization, {
    initialSchema: "0029",
    initialState: "replacing",
    initialTargetInstalled: true,
    journal: {
      lastCompletedOperation: "atomic_switch",
      nextSafeOperation: "start",
    },
  });
  const result = await recoverReplacementBootstrap({
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  });
  assert.equal(result.disposition, "rolled_back");
  assert.equal(dependencies.inspectState().state, "rolled_back");
  assert.deepEqual(dependencies.inspectState().operations, ["restore_artifact", "restore_service", "restart_rollback"]);
});

test("a new operator process resumes the next canonical idempotent host operation", async () => {
  const dependencies = await createDisposableReplacementDependencies(authorization, {
    initialSchema: "0029",
    initialState: "verified",
    journal: {
      lastCompletedOperation: "stage_release",
      nextSafeOperation: "stage_service",
    },
  });
  const result = await recoverReplacementBootstrap({
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  });
  assert.equal(result.disposition, "resumed");
  assert.deepEqual(dependencies.inspectState().operations, ["stage_service"]);
  assert.equal(dependencies.inspectState().state, "staged");
  const second = await recoverReplacementBootstrap({
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  });
  assert.equal(second.disposition, "resumed");
  assert.equal(dependencies.inspectState().state, "replacing");
  assert.deepEqual(dependencies.inspectState().operations, ["stage_service"]);
  const third = await recoverReplacementBootstrap({
    authorizationId: authorization.authorizationId,
    assertedAgentId: NAMED_CANARY_ID,
    actor: authorization.operatorIdentity,
    dependencies,
  });
  assert.equal(third.disposition, "resumed");
  assert.deepEqual(dependencies.inspectState().operations, ["stage_service", "stop"]);
});

test("fresh processes continue failed and rolling-back restoration to terminal", async () => {
  for (const initialState of ["failed", "rolling_back"]) {
    const dependencies = await createDisposableReplacementDependencies(authorization, {
      initialSchema: "0029",
      initialState,
      initialTargetInstalled: true,
      journal: {
        lastCompletedOperation: "stop",
        nextSafeOperation: "atomic_switch",
      },
    });
    const result = await recoverReplacementBootstrap({
      authorizationId: authorization.authorizationId,
      assertedAgentId: NAMED_CANARY_ID,
      actor: authorization.operatorIdentity,
      dependencies,
    });
    assert.equal(result.disposition, "rolled_back");
    assert.equal(dependencies.inspectState().state, "rolled_back");
    assert.deepEqual(dependencies.inspectState().operations, [
      "restore_artifact",
      "restore_service",
      "restart_rollback",
    ]);
  }
});

test("fresh processes reconcile every host-receipt-before-database-transition window", async () => {
  for (const [initialState, lastCompletedOperation, nextSafeOperation, expectedState] of [
    ["approved", "drain", "stage_node", "draining"],
    ["draining", "stage_release", "stage_service", "verified"],
    ["verified", "stage_service", "stop", "staged"],
    ["staged", "stage_service", "stop", "replacing"],
  ]) {
    const dependencies = await createDisposableReplacementDependencies(authorization, {
      initialSchema: "0029",
      initialState,
      journal: { lastCompletedOperation, nextSafeOperation },
    });
    const result = await recoverReplacementBootstrap({
      authorizationId: authorization.authorizationId,
      assertedAgentId: NAMED_CANARY_ID,
      actor: authorization.operatorIdentity,
      dependencies,
    });
    assert.equal(result.disposition, "resumed");
    assert.equal(dependencies.inspectState().state, expectedState);
    assert.equal(dependencies.inspectState().operations.length, 0);
  }
});

test("drain and staging failures undrain exactly once and never stop or switch", async () => {
  for (const failAt of ["stage_node", "stage_release", "stage_service"]) {
    const dependencies = await createDisposableReplacementDependencies(authorization, { failAt });
    await assert.rejects(() =>
      executeReplacementBootstrap({
        mode: "disposable",
        authorizationId: authorization.authorizationId,
        assertedAgentId: NAMED_CANARY_ID,
        actor: authorization.operatorIdentity,
        acknowledge: REPLACEMENT_BOOTSTRAP_PROTOCOL,
        dependencies,
      }),
    );
    const operations = dependencies.inspectState().operations;
    assert.equal(operations.filter((item) => item === "undrain").length, 1);
    assert.equal(operations.includes("stop"), false);
    assert.equal(operations.includes("atomic_switch"), false);
  }
  const uncertain = await createDisposableReplacementDependencies(authorization, { failAfterDrainEffect: true });
  await assert.rejects(() =>
    executeReplacementBootstrap({
      mode: "disposable",
      authorizationId: authorization.authorizationId,
      assertedAgentId: NAMED_CANARY_ID,
      actor: authorization.operatorIdentity,
      acknowledge: REPLACEMENT_BOOTSTRAP_PROTOCOL,
      dependencies: uncertain,
    }),
  );
  assert.deepEqual(uncertain.inspectState().operations.slice(-2), ["drain", "undrain"]);
});
