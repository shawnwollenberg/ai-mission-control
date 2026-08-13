import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createFilesystemWriteAuthority,
  evaluateFilesystemWrite,
  FILESYSTEM_WRITE_FORBIDDEN,
} from "../domain/filesystem-write-authority.ts";

const sha = "a".repeat(64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "filesystem-write-authority-"));
  const worktree = join(root, "worktree");
  const sandbox = join(root, "sandbox");
  const temporary = join(sandbox, "tmp");
  const staging = join(root, "artifacts");
  const outside = join(root, "outside");
  await Promise.all([worktree, temporary, staging, outside].map((path) => mkdir(path, { recursive: true })));
  const authority = await createFilesystemWriteAuthority({
    acceptanceRunId: randomUUID(),
    candidateArtifactSha256: sha,
    workspaceId: randomUUID(),
    missionId: randomUUID(),
    childMissionId: randomUUID(),
    executionId: randomUUID(),
    assignmentId: randomUUID(),
    assignmentAttempt: 1,
    providerAttemptId: "1-1",
    agentId: randomUUID(),
    provider: "codex",
    model: "gpt-test",
    runtimeProfileId: "codex-implementation-macos-v2",
    repositoryId: randomUUID(),
    repositorySnapshotSha256: sha,
    worktreeIdentitySha256: sha,
    approvedWritableRoots: [worktree, sandbox, staging],
    readOnlyRoots: [outside],
    temporaryRoot: temporary,
    sandboxRoot: sandbox,
    artifactStagingRoot: staging,
  });
  return { root, worktree, sandbox, temporary, staging, outside, authority };
}

test("allows exact governed roots and rejects traversal, sibling, home, ssh, and unrelated temp paths", async () => {
  const f = await fixture();
  assert.equal((await evaluateFilesystemWrite(f.authority, join(f.worktree, "allowed.txt"), "create")).allowed, true);
  for (const target of [
    join(f.worktree, "..", "outside", "escape.txt"),
    join(f.outside, "sibling.txt"),
    join(f.root, "home", "file"),
    join(f.root, ".ssh", "config"),
    join(tmpdir(), `unrelated-${randomUUID()}`),
  ])
    await assert.rejects(evaluateFilesystemWrite(f.authority, target, "create"), (error) => {
      assert.equal(error.details?.reason_code, FILESYSTEM_WRITE_FORBIDDEN);
      return true;
    });
});

test("resolves direct and nested symlinks, permits links to approved roots, and rejects loops", async () => {
  const f = await fixture();
  await symlink(f.outside, join(f.worktree, "escape"));
  await mkdir(join(f.worktree, "nested"));
  await symlink(f.outside, join(f.worktree, "nested", "escape"));
  await symlink(f.worktree, join(f.sandbox, "approved-link"));
  await symlink("loop-b", join(f.worktree, "loop-a"));
  await symlink("loop-a", join(f.worktree, "loop-b"));
  await assert.rejects(evaluateFilesystemWrite(f.authority, join(f.worktree, "escape", "x"), "create"));
  await assert.rejects(evaluateFilesystemWrite(f.authority, join(f.worktree, "nested", "escape", "x"), "create"));
  assert.equal(
    (await evaluateFilesystemWrite(f.authority, join(f.sandbox, "approved-link", "inside"), "create")).allowed,
    true,
  );
  await assert.rejects(evaluateFilesystemWrite(f.authority, join(f.worktree, "loop-a", "x"), "create"));
});

test("denied decision leaves the disposable target unchanged and authority mutation fails closed", async () => {
  const f = await fixture();
  const target = join(f.outside, "unchanged.txt");
  await writeFile(target, "before");
  await assert.rejects(evaluateFilesystemWrite(f.authority, target, "modify"));
  assert.equal(await readFile(target, "utf8"), "before");
  await assert.rejects(
    evaluateFilesystemWrite(
      { ...f.authority, approvedWritableRoots: [...f.authority.approvedWritableRoots, f.outside] },
      target,
      "modify",
    ),
  );
});

test("allows a missing descendant but rejects a non-directory path component substitution", async () => {
  const f = await fixture();
  const missing = join(f.worktree, "missing", "nested", "result.txt");
  assert.equal((await evaluateFilesystemWrite(f.authority, missing, "create")).allowed, true);
  const component = join(f.worktree, "component");
  await writeFile(component, "not-a-directory");
  await assert.rejects(evaluateFilesystemWrite(f.authority, join(component, "result.txt"), "create"), (error) => {
    assert.equal(error.details?.reason_code, FILESYSTEM_WRITE_FORBIDDEN);
    return true;
  });
});

test("candidate, run, assignment, provider, runtime, and root expansion mutations fail closed", async () => {
  const f = await fixture();
  const target = join(f.worktree, "bound.txt");
  for (const mutation of [
    { acceptanceRunId: randomUUID() },
    { candidateArtifactSha256: "b".repeat(64) },
    { assignmentId: randomUUID() },
    { provider: "claude_code" },
    { runtimeProfileId: "codex-planning-macos-v2" },
    { approvedWritableRoots: [...f.authority.approvedWritableRoots, f.outside] },
  ])
    await assert.rejects(evaluateFilesystemWrite({ ...f.authority, ...mutation }, target, "create"), (error) => {
      assert.equal(error.details?.reason_code, FILESYSTEM_WRITE_FORBIDDEN);
      return true;
    });
});
