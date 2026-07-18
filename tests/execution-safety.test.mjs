import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateExecutionRequest } from "../execution/protocol.ts";
import { runSafeProcess } from "../execution/safe-process.ts";
import { executionBranch, validateRepositoryPath } from "../execution/worktree-manager.ts";
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
