import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
process.env.APP_ENV = "production";

const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const { registerRemoteAgent } = await import("../application/remote-agent-registry.ts");
const {
  registerMissionAgentRepository,
  configureDisposableRepositoryAuthority,
  configureProductionReadOnlyPlanningAuthority,
} = await import("../application/registry.ts");
const { repositoryAuthorityBindingHash, productionReadOnlyPlanningOperations } =
  await import("../domain/repository-authority.ts");
const { deriveStableRepositoryIdentity } = await import("../application/repository-identity.ts");

const workspaceId = randomUUID();
const owner = { workspaceId, userId: randomUUID(), role: "owner" };
let claude;
let codex;
let repositoryId;

test.before(async () => {
  await getDatabasePool().query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Production Read Only')", [
    workspaceId,
    `production-read-only-${workspaceId}`,
  ]);
  const register = (name, adapter) =>
    registerRemoteAgent({
      actor: owner,
      name,
      endpoint: "https://pull.invalid/messages",
      capabilities: [
        "repository.read",
        "artifact.create",
        "plan.generate",
        "plan.critique",
        "plan.revise",
        "plan.review",
      ],
      supportedDomains: ["software_delivery"],
      deliveryMode: "pull",
      missionAgentAdapter: adapter,
    });
  claude = await register("Claude planning", "claude-code");
  codex = await register("Codex planning", "codex");
  const remotes = [{ name: "origin", url: "https://github.com/example/read-only-fixture.git" }];
  const identity = deriveStableRepositoryIdentity({ remotes, repositoryName: "read-only-fixture" });
  const repository = await registerMissionAgentRepository({
    workspaceId,
    agentId: claude.agentId,
    name: "read-only-fixture",
    fingerprint: identity.fingerprint,
    defaultBranch: "main",
    commit: "b".repeat(40),
    identityVersion: identity.identityVersion,
    canonicalRemoteUrl: identity.canonicalRemoteUrl,
    selectedRemote: identity.selectedRemote,
    remotes,
  });
  repositoryId = repository.repository_id;
  await registerMissionAgentRepository({
    workspaceId,
    agentId: codex.agentId,
    name: "read-only-fixture",
    fingerprint: identity.fingerprint,
    defaultBranch: "main",
    commit: "b".repeat(40),
    identityVersion: identity.identityVersion,
    canonicalRemoteUrl: identity.canonicalRemoteUrl,
    selectedRemote: identity.selectedRemote,
    remotes,
  });
});

test.after(async () => {
  const client = await getDatabasePool().connect();
  try {
    const authorityHash = (
      await client.query("SELECT repository_authority_hash FROM repositories WHERE workspace_id=$1 LIMIT 1", [
        workspaceId,
      ])
    ).rows[0]?.repository_authority_hash;
    if (authorityHash)
      await client.query("SELECT set_config('mission_control.repository_authority_binding',$1,false)", [authorityHash]);
    for (const table of [
      "repository_authority_receipts",
      "agent_resource_permissions",
      "repositories",
      "agent_credentials",
      "agents",
      "outbox",
      "events",
      "commands",
      "aggregate_heads",
    ])
      await client.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
    await client.query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  } finally {
    client.release();
  }
  await closeDatabasePool();
});

test("production read-only authority persists exact receipt, read-only projection, and read-only grants", async () => {
  const commandId = randomUUID();
  await configureProductionReadOnlyPlanningAuthority({
    actor: owner,
    commandId,
    repositoryId,
    planningAgentIds: [claude.agentId, codex.agentId],
    validationCommands: [["npm", "run", "format:check"]],
  });
  const row = (
    await getDatabasePool().query(
      `SELECT r.*,(SELECT count(*)::int FROM repository_authority_receipts receipt
         WHERE receipt.workspace_id=r.workspace_id AND receipt.repository_id=r.repository_id
           AND receipt.authority_hash=r.repository_authority_hash) receipt_count
       FROM repositories r WHERE r.workspace_id=$1 AND r.repository_id=$2`,
      [workspaceId, repositoryId],
    )
  ).rows[0];
  assert.equal(row.repository_authority.profile, "production_read_only_planning/1");
  assert.deepEqual(row.repository_authority.allowedOperations, productionReadOnlyPlanningOperations);
  assert.equal(row.repository_authority_hash, repositoryAuthorityBindingHash(row.repository_authority, commandId));
  assert.equal(row.receipt_count, 1);
  assert.equal(row.read_allowed, true);
  for (const field of [
    "write_allowed",
    "commit_allowed",
    "isolated_worktree_write_allowed",
    "mission_agent_local_commit_allowed",
    "provider_direct_commit_allowed",
    "push_allowed",
    "pull_request_allowed",
    "merge_allowed",
    "publication_allowed",
    "deployment_allowed",
    "infrastructure_mutation_allowed",
  ])
    assert.equal(row[field], false, field);
  const permissions = (
    await getDatabasePool().query(
      "SELECT permissions FROM agent_resource_permissions WHERE workspace_id=$1 AND resource_type='repository' AND resource_id=$2 ORDER BY agent_id",
      [workspaceId, repositoryId],
    )
  ).rows;
  assert.equal(permissions.length, 2);
  assert.ok(permissions.every(({ permissions: value }) => JSON.stringify(value) === '["read"]'));
  assert.deepEqual(row.validation_commands, [["npm", "run", "format:check"]]);
});

test("production authority remains owner-only and disposable implementation authority remains prohibited", async () => {
  await assert.rejects(
    configureProductionReadOnlyPlanningAuthority({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      planningAgentIds: [claude.agentId],
      validationCommands: [],
    }),
    /requires owner-governed validation commands/,
  );
  await assert.rejects(
    configureProductionReadOnlyPlanningAuthority({
      actor: { ...owner, role: "member" },
      commandId: randomUUID(),
      repositoryId,
      planningAgentIds: [claude.agentId],
      validationCommands: [["npm", "run", "format:check"]],
    }),
    /Workspace owner permission is required/,
  );
  await assert.rejects(
    configureDisposableRepositoryAuthority({
      actor: owner,
      commandId: randomUUID(),
      repositoryId,
      implementationAgentIds: [codex.agentId],
    }),
    /unavailable in this runtime mode/,
  );
});
