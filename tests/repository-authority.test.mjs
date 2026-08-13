import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const {
  assertDisposableLocalImplementationAuthority,
  assertDisposableRepositoryAuthorityProjection,
  disposableLocalImplementationAuthority,
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
