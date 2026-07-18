import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePublicationPreflight } from "../git/publication-preflight.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mc-preflight-"));
  const remote = path.join(root, "remote.git"),
    worktree = path.join(root, "worktree");
  git(root, "init", "--bare", remote);
  git(root, "clone", remote, worktree);
  git(worktree, "config", "user.email", "acceptance@example.com");
  git(worktree, "config", "user.name", "Acceptance");
  await writeFile(path.join(worktree, "README.md"), "base\n");
  git(worktree, "add", "README.md");
  git(worktree, "commit", "-m", "base");
  git(worktree, "branch", "-M", "main");
  git(worktree, "push", "origin", "main");
  git(worktree, "checkout", "-b", "codex/valid");
  await writeFile(path.join(worktree, "CHANGE.md"), "bounded\n");
  git(worktree, "add", "CHANGE.md");
  git(worktree, "commit", "-m", "bounded change");
  return { root, worktree, commit: git(worktree, "rev-parse", "HEAD"), base: git(worktree, "rev-parse", "main") };
}
const input = (fixture, overrides = {}) => ({
  worktreePath: fixture.worktree,
  worktreeRoot: fixture.root,
  remote: "origin",
  allowedRemotes: ["origin"],
  targetBranch: "main",
  protectedBranches: ["main"],
  allowedBranchPrefixes: ["codex/"],
  generatedBranch: "codex/valid",
  approvedCommit: fixture.commit,
  force: false,
  ...overrides,
});

test("publication preflight confirms a provider-target common ancestor", async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const result = await validatePublicationPreflight(input(fixture));
  assert.equal(result.targetCommit, fixture.base);
  assert.equal(result.commonAncestor, fixture.base);
});

test("publication preflight returns no_common_history and never offers a force fallback", async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  git(fixture.worktree, "checkout", "--orphan", "codex/unrelated");
  git(fixture.worktree, "rm", "-rf", ".");
  await writeFile(path.join(fixture.worktree, "UNRELATED.md"), "separate history\n");
  git(fixture.worktree, "add", "UNRELATED.md");
  git(fixture.worktree, "commit", "-m", "unrelated");
  const commit = git(fixture.worktree, "rev-parse", "HEAD");
  await assert.rejects(
    validatePublicationPreflight(input(fixture, { generatedBranch: "codex/unrelated", approvedCommit: commit })),
    (error) => error.details?.failureType === "no_common_history" && !/force|rewrite|replace/i.test(error.message),
  );
  await assert.rejects(
    validatePublicationPreflight(input(fixture, { force: true })),
    (error) => error.details?.failureType === "force_push_prohibited",
  );
});

test("publication preflight invalidates changed commits and dirty worktrees", async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    validatePublicationPreflight(input(fixture, { approvedCommit: fixture.base })),
    (error) => error.details?.failureType === "approved_commit_changed",
  );
  await writeFile(path.join(fixture.worktree, "DIRTY.md"), "dirty\n");
  await assert.rejects(
    validatePublicationPreflight(input(fixture)),
    (error) => error.details?.failureType === "working_tree_dirty",
  );
});

test("publication preflight revalidates provider target movement", async (t) => {
  const fixture = await repository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const first = await validatePublicationPreflight(input(fixture));
  git(fixture.worktree, "checkout", "main");
  await writeFile(path.join(fixture.worktree, "TARGET.md"), "target advanced\n");
  git(fixture.worktree, "add", "TARGET.md");
  git(fixture.worktree, "commit", "-m", "advance target");
  git(fixture.worktree, "push", "origin", "main");
  const moved = git(fixture.worktree, "rev-parse", "main");
  git(fixture.worktree, "checkout", "codex/valid");
  const second = await validatePublicationPreflight(input(fixture));
  assert.notEqual(second.targetCommit, first.targetCommit);
  assert.equal(second.targetCommit, moved);
  assert.equal(second.commonAncestor, fixture.base);
});
