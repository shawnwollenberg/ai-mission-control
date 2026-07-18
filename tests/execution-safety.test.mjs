import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExecutionRequest } from "../execution/protocol.ts";
import { runSafeProcess } from "../execution/safe-process.ts";
import { executionBranch, validateRepositoryPath } from "../execution/worktree-manager.ts";
import { failureDisposition, failurePolicies } from "../execution/failures.ts";
import { requestExecution, rehydrateExecution, transitionExecution } from "../domain/execution.ts";
const id = () => crypto.randomUUID();
test("protocol 1.0 validates identity and rejects unsupported versions", () => {
  const request = {
    protocolVersion: "1.0",
    kind: "execution.request",
    executionId: id(),
    missionId: id(),
    taskId: id(),
    workspaceId: id(),
    agentId: id(),
    attempt: 1,
    objective: "Bounded change",
    instructions: "Edit one file",
    expectedOutput: "Passing tests",
    constraints: ["No push"],
    repository: { repositoryId: id(), baseRef: "main" },
    approvalPolicy: { mergeRequired: true, deploymentRequired: true, destructiveActionRequired: true },
    timeoutSeconds: 60,
    heartbeatIntervalSeconds: 30,
    idempotencyKey: id(),
  };
  assert.equal(validateExecutionRequest(request).protocolVersion, "1.0");
  assert.throws(
    () => validateExecutionRequest({ ...request, protocolVersion: "2.0" }),
    (error) => error?.code === "validation_failed",
  );
});
test("safe process enforces cwd, environment allowlist, cancellation, and redaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "safe-process-"));
  process.env.SHOULD_NOT_LEAK = "private-value";
  const result = await runSafeProcess({
    executable: process.execPath,
    args: ["-e", "console.log(process.env.SHOULD_NOT_LEAK, process.env.PATH); console.error('secret-token')"],
    cwd: root,
    allowedRoot: root,
    env: { PATH: process.env.PATH },
    timeoutMs: 5000,
    redact: ["secret-token"],
  });
  assert.match(result.stdout, /undefined/);
  assert.doesNotMatch(result.stdout, /private-value/);
  assert.match(result.stderr, /\[REDACTED\]/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const cancelled = await runSafeProcess({
    executable: process.execPath,
    args: ["-e", "setTimeout(()=>{},5000)"],
    cwd: root,
    allowedRoot: root,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  assert.equal(cancelled.cancelled, true);
});
test("repository guard rejects symlink escape and branch generation is deterministic", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "repo-root-")),
    outside = await mkdtemp(path.join(os.tmpdir(), "outside-repo-")),
    link = path.join(root, "escape");
  await symlink(outside, link);
  await assert.rejects(
    () => validateRepositoryPath(link, root),
    (error) => error?.code === "validation_failed",
  );
  const branch = executionBranch(id(), id(), id());
  assert.match(branch, /^codex\/[0-9a-f-]+\/[0-9a-f-]+\/[0-9a-f-]+$/);
});
test("every Phase 2 failure classification has an explicit retry disposition", () => {
  assert.deepEqual(Object.keys(failurePolicies).sort(), [
    "artifact_failure",
    "authentication_failure",
    "cancellation",
    "codex_start_failure",
    "command_failure",
    "execution_failure",
    "invalid_configuration",
    "protocol_error",
    "repository_unavailable",
    "test_failure",
    "timeout",
    "unknown",
    "worker_lost",
  ]);
  assert.equal(failureDisposition("authentication_failure"), "non-retryable");
  assert.equal(failureDisposition("worker_lost"), "retryable");
});
test("execution aggregate enforces valid and terminal transitions", () => {
  const executionId = id(),
    missionId = id(),
    requestedEvent = requestExecution({
      missionId,
      taskId: id(),
      agentId: id(),
      repositoryId: id(),
      attempt: 1,
      adapterType: "codex",
      timeoutSeconds: 60,
      idempotencyKey: id(),
    }),
    created = {
      position: 1,
      eventId: id(),
      eventType: requestedEvent.eventType,
      eventSchemaVersion: 1,
      aggregateType: "execution",
      aggregateId: executionId,
      aggregateVersion: 1,
      missionId,
      workspaceId: id(),
      correlationId: missionId,
      actorType: "human",
      actorId: "owner",
      occurredAt: new Date().toISOString(),
      payload: requestedEvent.payload,
      metadata: {},
    };
  const requested = rehydrateExecution([created]);
  assert.equal(transitionExecution(requested, "accepted").eventType, "execution.accepted");
  assert.throws(
    () => transitionExecution(requested, "succeeded"),
    (error) => error?.code === "invalid_transition",
  );
  const succeeded = {
    ...created,
    position: 2,
    eventId: id(),
    aggregateVersion: 2,
    eventType: "execution.succeeded",
    payload: { status: "succeeded" },
  };
  const terminal = rehydrateExecution([created, succeeded]);
  assert.throws(
    () => transitionExecution(terminal, "running"),
    (error) => error?.code === "invalid_transition",
  );
});
