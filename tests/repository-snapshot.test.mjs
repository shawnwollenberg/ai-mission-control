import assert from "node:assert/strict";
import test from "node:test";
import { canonicalHash } from "../lib/canonical-json.ts";
import { parseCompleteRepositoryState, repositorySnapshotBytes } from "../domain/repository-snapshot.ts";

function snapshot(overrides = {}) {
  const trackedManifest = [
    {
      path: "bin/run.sh",
      type: "file",
      mode: "100755",
      size: 12,
      contentSha256: "1".repeat(64),
      gitObjectId: "a".repeat(40),
      symlinkTarget: null,
    },
    {
      path: "current",
      type: "symlink",
      mode: "120000",
      size: 10,
      contentSha256: "2".repeat(64),
      gitObjectId: "b".repeat(40),
      symlinkTarget: "bin/run.sh",
    },
    {
      path: "vendor/example",
      type: "submodule",
      mode: "160000",
      size: 0,
      contentSha256: "3".repeat(64),
      gitObjectId: "c".repeat(40),
      symlinkTarget: null,
    },
  ];
  const untrackedManifest = [];
  const relevantIgnoredManifest = [];
  const submodules = [{ path: "vendor/example", commit: "c".repeat(40), status: "clean" }];
  const state = {
    schemaVersion: "complete_repository_state/3",
    repositoryIdentity: "7".repeat(64),
    repositoryRootIdentity: "4".repeat(64),
    baseBranch: "main",
    baseCommit: "d".repeat(40),
    headCommit: "d".repeat(40),
    cleanWorktree: true,
    trackedStatusHash: "5".repeat(64),
    trackedStatusEmpty: true,
    trackedIndexHash: "6".repeat(64),
    trackedManifestHash: canonicalHash(trackedManifest),
    trackedCount: trackedManifest.length,
    trackedContentMatchesIndex: true,
    trackedManifest,
    untrackedPolicyId: "include-untracked/1",
    untrackedManifestHash: canonicalHash(untrackedManifest),
    untrackedCount: 0,
    untrackedManifest,
    ignoredPolicyId: "runtime-relevant-ignored/1",
    relevantIgnoredManifestHash: canonicalHash(relevantIgnoredManifest),
    relevantIgnoredCount: 0,
    relevantIgnoredManifest,
    submoduleStatusHash: canonicalHash(submodules),
    submodules,
    ...overrides,
  };
  return { ...state, snapshotHash: canonicalHash(state) };
}

test("complete repository snapshot binds identity, branch, commit, modes, symlinks, and submodules", () => {
  const value = snapshot();
  const parsed = parseCompleteRepositoryState(value, { branch: "main", commit: "d".repeat(40) });
  assert.deepEqual(parsed, value);
  assert.equal(parsed.trackedManifest[0].mode, "100755");
  assert.equal(parsed.trackedManifest[1].symlinkTarget, "bin/run.sh");
  assert.equal(parsed.submodules[0].commit, "c".repeat(40));
  assert.equal(canonicalHash(JSON.parse(repositorySnapshotBytes(parsed).toString("utf8"))), parsed.snapshotHash);
});

test("complete repository snapshots fail closed for missing, changed, unsafe, or internally inconsistent state", () => {
  assert.throws(() => parseCompleteRepositoryState(undefined), /required/);
  assert.throws(() => parseCompleteRepositoryState({}), /unsupported/);
  assert.throws(() => parseCompleteRepositoryState(snapshot(), { branch: "release" }), /invalid/);
  assert.throws(() => parseCompleteRepositoryState({ ...snapshot(), snapshotHash: "0".repeat(64) }), /snapshot hash/);

  const changed = snapshot();
  changed.trackedManifest[0].contentSha256 = "9".repeat(64);
  assert.throws(() => parseCompleteRepositoryState(changed), /invalid/);

  const unsafe = snapshot();
  unsafe.trackedManifest[0].path = "../escape";
  unsafe.trackedManifestHash = canonicalHash(unsafe.trackedManifest);
  unsafe.snapshotHash = canonicalHash(
    Object.fromEntries(Object.entries(unsafe).filter(([key]) => key !== "snapshotHash")),
  );
  assert.throws(() => parseCompleteRepositoryState(unsafe), /unsafe/);

  const dirty = snapshot({ cleanWorktree: true, untrackedCount: 1 });
  assert.throws(() => parseCompleteRepositoryState(dirty), /invalid/);
});
