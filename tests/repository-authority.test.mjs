import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  assertDisposableLocalImplementationAuthority,
  assertDisposableRepositoryAuthorityProjection,
  assertProductionReadOnlyMissionAdmission,
  assertProductionReadOnlyPlanningAuthority,
  assertProductionReadOnlyPlanningAuthorityProjection,
  disposableLocalImplementationAuthority,
  productionReadOnlyPlanningAuthority,
  productionReadOnlyPlanningOperations,
  repositoryAuthorityBindingHash,
  repositoryAuthorityHash,
} = await import("../domain/repository-authority.ts");

const agentA = "11111111-1111-4111-8111-111111111111";
const agentB = "22222222-2222-4222-8222-222222222222";
const commandId = "33333333-3333-4333-8333-333333333333";

function readyProjection(overrides = {}) {
  const authority = disposableLocalImplementationAuthority([agentA]);
  return {
    authority,
    authorityHash: repositoryAuthorityBindingHash(authority, commandId),
    authorityCommandId: commandId,
    authorityReceiptCount: 1,
    readAllowed: true,
    writeAllowed: false,
    commitAllowed: false,
    isolatedWorktreeWriteAllowed: true,
    missionAgentLocalCommitAllowed: true,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    ...overrides,
  };
}

test("disposable authority separates isolated mutation and Mission Agent commit from remote authority", () => {
  const authority = disposableLocalImplementationAuthority([agentB, agentA, agentA]);
  assert.deepEqual(authority.implementationAgentIds, [agentA, agentB]);
  assert.equal(authority.readAllowed, true);
  assert.equal(authority.isolatedWorktreeWriteAllowed, true);
  assert.equal(authority.missionAgentLocalCommitAllowed, true);
  assert.equal(authority.providerDirectCommitAllowed, false);
  assert.equal(authority.pushAllowed, false);
  assert.equal(authority.pullRequestAllowed, false);
  assert.equal(authority.mergeAllowed, false);
  assert.equal(authority.publicationAllowed, false);
  assert.equal(authority.deploymentAllowed, false);
  assert.equal(authority.infrastructureMutationAllowed, false);
  assert.match(repositoryAuthorityHash(authority), /^[a-f0-9]{64}$/);
});

function readOnlyProjection(overrides = {}) {
  const authority = productionReadOnlyPlanningAuthority([agentA, agentB]);
  return {
    authority,
    authorityHash: repositoryAuthorityBindingHash(authority, commandId),
    authorityCommandId: commandId,
    authorityReceiptCount: 1,
    readAllowed: true,
    writeAllowed: false,
    commitAllowed: false,
    isolatedWorktreeWriteAllowed: false,
    missionAgentLocalCommitAllowed: false,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    ...overrides,
  };
}

test("production read-only planning authority is exact and contains no mutation capability", () => {
  const authority = productionReadOnlyPlanningAuthority([agentB, agentA, agentA]);
  assert.deepEqual(authority.planningAgentIds, [agentA, agentB]);
  assert.deepEqual(authority.allowedOperations, productionReadOnlyPlanningOperations);
  for (const field of [
    "isolatedWorktreeWriteAllowed",
    "missionAgentLocalCommitAllowed",
    "providerDirectCommitAllowed",
    "pushAllowed",
    "pullRequestAllowed",
    "mergeAllowed",
    "publicationAllowed",
    "deploymentAllowed",
    "infrastructureMutationAllowed",
  ])
    assert.equal(authority[field], false, field);
  assert.doesNotThrow(() => assertProductionReadOnlyPlanningAuthority(authority));
  assert.doesNotThrow(() => assertProductionReadOnlyPlanningAuthorityProjection(readOnlyProjection()));
  for (const expansion of [
    { fileCreateAllowed: true },
    { isolatedWorktreeWriteAllowed: true },
    { missionAgentLocalCommitAllowed: true },
    { pushAllowed: true },
    { pullRequestAllowed: true },
    { deploymentAllowed: true },
  ])
    assert.throws(
      () => assertProductionReadOnlyPlanningAuthority({ ...authority, ...expansion }),
      /exact production read-only planning profile/,
    );
});

test("production read-only mission admission requires production, explicit planning-only intent, and exact agents", () => {
  const authority = productionReadOnlyPlanningAuthority([agentA, agentB]);
  const valid = { authority, runtimeMode: "production", planningOnly: true, plannerAgentIds: [agentA, agentB, agentA] };
  assert.equal(assertProductionReadOnlyMissionAdmission(valid), authority);
  assert.throws(
    () => assertProductionReadOnlyMissionAdmission({ ...valid, runtimeMode: "test" }),
    /requires production runtime mode/,
  );
  assert.throws(
    () => assertProductionReadOnlyMissionAdmission({ ...valid, planningOnly: false }),
    /explicit planning-only mission/,
  );
  assert.throws(
    () => assertProductionReadOnlyMissionAdmission({ ...valid, preferredExecutorAgentId: agentA }),
    /explicit planning-only mission/,
  );
  assert.throws(
    () => assertProductionReadOnlyMissionAdmission({ ...valid, plannerAgentIds: [commandId] }),
    /outside production read-only repository authority/,
  );
});

test("production read-only projection fails closed on every mutation column", () => {
  for (const [field, value] of [
    ["writeAllowed", true],
    ["commitAllowed", true],
    ["isolatedWorktreeWriteAllowed", true],
    ["missionAgentLocalCommitAllowed", true],
    ["providerDirectCommitAllowed", true],
    ["pushAllowed", true],
    ["pullRequestAllowed", true],
    ["mergeAllowed", true],
    ["publicationAllowed", true],
    ["deploymentAllowed", true],
    ["infrastructureMutationAllowed", true],
  ])
    assert.throws(
      () => assertProductionReadOnlyPlanningAuthorityProjection(readOnlyProjection({ [field]: value })),
      /contains mutation capability/,
      field,
    );
});

test("production planning-only orchestration omits executor and implementation approval paths", async () => {
  const commands = await readFile(new URL("../application/consensus-plan-commands.ts", import.meta.url), "utf8");
  const route = await readFile(new URL("../app/api/consensus-plans/route.ts", import.meta.url), "utf8");
  const registry = await readFile(new URL("../application/registry.ts", import.meta.url), "utf8");
  assert.match(commands, /const executor = productionReadOnly\s*\? undefined/);
  assert.match(commands, /participants: \[[\s\S]{0,120}\.\.\.\(executor \? \[executor\] : \[\]\)/);
  assert.match(commands, /Production read-only consensus completed without implementation authority/);
  assert.match(commands, /if \(!decided\.preferred_executor_agent_id && !decided\.preferred_executor_model_id\)/);
  assert.match(route, /body\.planningOnly !== true/);
  assert.match(route, /planningOnly: body\.planningOnly/);
  assert.match(registry, /Production read-only authority cannot be rebound while repository execution is active/);
  assert.match(registry, /execution\.status NOT IN\('succeeded','failed','timed_out','cancelled'\)/);
});

test("authority parser rejects generic-write, provider-commit, push, PR, publication, and deployment expansion", () => {
  const authority = disposableLocalImplementationAuthority([agentA]);
  for (const expansion of [
    { providerDirectCommitAllowed: true },
    { pushAllowed: true },
    { pullRequestAllowed: true },
    { mergeAllowed: true },
    { publicationAllowed: true },
    { deploymentAllowed: true },
    { infrastructureMutationAllowed: true },
    { genericWriteAllowed: true },
  ])
    assert.throws(
      () => assertDisposableLocalImplementationAuthority({ ...authority, ...expansion }),
      /exact disposable local implementation profile/,
    );
});

test("push-disabled preflight authority passes and a push-enabled fixture fails", () => {
  assert.doesNotThrow(() => assertDisposableRepositoryAuthorityProjection(readyProjection()));
  assert.throws(
    () => assertDisposableRepositoryAuthorityProjection(readyProjection({ pushAllowed: true })),
    /push, PR, publication/,
  );
  assert.throws(
    () => assertDisposableRepositoryAuthorityProjection(readyProjection({ writeAllowed: true })),
    /legacy generic write or commit/,
  );
});

test("authority hash changes on implementation-agent downgrade or expansion", () => {
  const initial = disposableLocalImplementationAuthority([agentA]);
  const changed = disposableLocalImplementationAuthority([agentB]);
  assert.notEqual(repositoryAuthorityHash(initial), repositoryAuthorityHash(changed));
  assert.notEqual(repositoryAuthorityBindingHash(initial, agentA), repositoryAuthorityBindingHash(initial, agentB));
});

test("disposable authority command is unavailable outside disposable acceptance or tests", async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    const { configureDisposableRepositoryAuthority } = await import("../application/registry.ts");
    await assert.rejects(
      configureDisposableRepositoryAuthority({
        actor: { workspaceId: agentA, userId: agentB, role: "owner" },
        commandId,
        repositoryId: agentA,
        implementationAgentIds: [agentA],
      }),
      /unavailable in this runtime mode/,
    );
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
});

test("implementation provider is denied direct commit while Mission Agent owns the local commit", async () => {
  const source = await readFile(new URL("../scripts/mission-agent-080.template.mjs", import.meta.url), "utf8");
  const harness = await readFile(new URL("../scripts/run-consensus-real-acceptance.ts", import.meta.url), "utf8");
  const authorityRoute = await readFile(
    new URL("../app/api/agents/[agentId]/repositories/[repositoryId]/route.ts", import.meta.url),
    "utf8",
  );
  const registrySource = await readFile(new URL("../application/registry.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /Do not commit; Mission Agent will independently inspect the diff, rerun authoritative validation, and create the local commit/,
  );
  assert.match(source, /AgentAssignmentLeaseRenewed/);
  assert.match(source, /"commit",\s*"-m"/s);
  assert.match(source, /Do not push, create a pull request, merge, deploy/);
  assert.match(harness, /repositoryPermission: "isolated_worktree_write"/);
  assert.match(harness, /createSessionToken/);
  assert.match(harness, /authenticated repository authority receipt must be durable/);
  assert.match(harness, /method: "PATCH"/);
  assert.doesNotMatch(harness, /configureDisposableRepositoryAuthority\s*\(/);
  assert.equal((authorityRoute.match(/if \(originError\) return originError;/g) ?? []).length, 2);
  assert.match(registrySource, /\["disposable_acceptance", "test"\]\.includes\(missionControlRuntimeMode\(\)\)/);
  assert.match(registrySource, /Disposable repository authority is unavailable in this runtime mode/);
  assert.doesNotMatch(harness.match(/role: "executor"[\s\S]{0,800}/)?.[0] ?? "", /repositoryPermission: "write"/);
});
