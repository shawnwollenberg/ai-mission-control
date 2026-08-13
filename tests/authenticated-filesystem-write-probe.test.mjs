import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertFilesystemWriteObservationBinding } from "../application/remote-agent-messages.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};
const classifiedError = (message, classification) => Object.assign(new Error(message), { classification });
const secretPredicateSource = readFileSync("scripts/mission-agent-080.template.mjs", "utf8").match(
  /function diagnosticTextContainsSecret[\s\S]*?(?=function structuredProviderAuthenticationFailure)/,
)?.[0];
assert.ok(secretPredicateSource, "Mission Agent filesystem observation secret predicate is present");
const { filesystemObservationContainsProhibitedSecret } = new Function(
  "Buffer",
  `${secretPredicateSource}; return { diagnosticTextContainsSecret, diagnosticTextContainsExactSecret, filesystemObservationContainsProhibitedSecret };`,
)(Buffer);

async function loadProbe(root, protocolMessage, spawnJournaledProvider = () => undefined) {
  const source = await readFile("scripts/mission-agent-080.template.mjs", "utf8");
  const body = source.match(/const filesystemPathInside = [\s\S]*?(?=async function runCodex\()/)?.[0];
  assert.ok(body, "Mission Agent filesystem probe implementation is present");
  return new Function(
    "relative",
    "isAbsolute",
    "sep",
    "normalize",
    "resolve",
    "lstat",
    "realpath",
    "join",
    "dirname",
    "parse",
    "sha256",
    "canonicalJson",
    "root",
    "mkdir",
    "classifiedError",
    "writeFile",
    "readFile",
    "spawnSync",
    "process",
    "randomUUID",
    "filesystemObservationContainsProhibitedSecret",
    "openSync",
    "fsyncSync",
    "closeSync",
    "rename",
    "protocolMessage",
    "rm",
    "spawnJournaledProvider",
    `${body}; return { evaluateProviderFilesystemWrite, recordAuthenticatedFilesystemWriteProbe, spawnProviderAfterFilesystemBoundary };`,
  )(
    relative,
    isAbsolute,
    sep,
    normalize,
    resolve,
    lstat,
    realpath,
    join,
    dirname,
    parse,
    sha256,
    canonicalJson,
    root,
    mkdir,
    classifiedError,
    writeFile,
    readFile,
    spawnSync,
    process,
    randomUUID,
    filesystemObservationContainsProhibitedSecret,
    openSync,
    fsyncSync,
    closeSync,
    rename,
    protocolMessage,
    rm,
    spawnJournaledProvider,
  );
}

test("real Mission Agent probe permits the worktree, denies the acceptance-owned sibling, seals evidence, and continues", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "authenticated-filesystem-probe-"));
  const missionAgentRoot = join(fixtureRoot, "mission-agent");
  const worktree = join(fixtureRoot, "worktree");
  const providerRoot = join(missionAgentRoot, "provider-sandboxes", "execution", "codex", "1-1");
  await Promise.all(
    [missionAgentRoot, worktree, providerRoot].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const profilePath = join(providerRoot, "sandbox.sb");
  await writeFile(
    profilePath,
    `(version 1)\n(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-read-metadata)\n(allow file-write* (subpath "${worktree}"))\n(allow file-write* (subpath "${providerRoot}"))\n`,
  );
  const assignment = {
    workspaceId: randomUUID(),
    missionId: randomUUID(),
    executionId: randomUUID(),
    assignmentId: randomUUID(),
    attempt: 1,
  };
  const authorityUnsigned = {
    schemaVersion: "filesystem-write-authority/1",
    acceptanceRunId: assignment.workspaceId,
    candidateArtifactSha256: "a".repeat(64),
    workspaceId: assignment.workspaceId,
    missionId: assignment.missionId,
    childMissionId: assignment.missionId,
    executionId: assignment.executionId,
    assignmentId: assignment.assignmentId,
    assignmentAttempt: 1,
    providerAttemptId: "1-1",
    agentId: randomUUID(),
    provider: "codex",
    model: "gpt-5.6-luna",
    runtimeProfileId: "codex-implementation-macos-v2",
    repositoryId: randomUUID(),
    repositorySnapshotSha256: "b".repeat(64),
    worktreeIdentitySha256: "c".repeat(64),
    approvedWritableRoots: [await realpath(worktree), await realpath(providerRoot)].sort(),
    readOnlyRoots: [],
    temporaryRoot: await realpath(providerRoot),
    sandboxRoot: await realpath(providerRoot),
    artifactStagingRoot: null,
  };
  const authority = { ...authorityUnsigned, authoritySha256: sha256(canonicalJson(authorityUnsigned)) };
  const messages = [];
  let providerSpawned = false;
  const probe = await loadProbe(
    missionAgentRoot,
    async (_config, _assignment, type, payload) => {
      messages.push({ type, payload });
      return { status: "accepted" };
    },
    () => {
      providerSpawned = true;
      return spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    },
  );
  const allowed = join(worktree, "allowed.txt");
  assert.equal((await probe.evaluateProviderFilesystemWrite(authority, allowed, "create")).allowed, true);
  await probe.recordAuthenticatedFilesystemWriteProbe(
    {},
    assignment,
    {
      filesystemWriteAuthority: authority,
      providerAttemptId: "1-1",
      workingDirectory: worktree,
      temporaryDirectory: providerRoot,
      profilePath,
      env: { PATH: process.env.PATH },
      runtimeProfileId: authority.runtimeProfileId,
    },
    "codex",
    "gpt-5.6-luna",
  );
  assert.equal(messages.length, 1);
  const observation = messages[0].payload.filesystemWriteObservation;
  assert.equal(observation.deniedWrite.reasonCode, "FILESYSTEM_WRITE_FORBIDDEN");
  assert.equal(observation.deniedWrite.existedBefore, false);
  assert.equal(observation.deniedWrite.existsAfter, false);
  assert.equal(observation.allowedWrite.allowed, true);
  assert.equal(observation.allowedWrite.existsAfter, true);
  assert.equal(observation.assignmentId, assignment.assignmentId);
  assert.equal(observation.providerAttemptId, "1-1");
  assert.equal(observation.authoritySha256, authority.authoritySha256);
  assert.equal(observation.evidenceSeal.subjectSha256, observation.observationIdentitySha256);
  const { observationIdentitySha256, evidenceSeal, ...unsignedObservation } = observation;
  assert.equal(sha256(canonicalJson(unsignedObservation)), observationIdentitySha256);
  assert.equal(evidenceSeal.algorithm, "sha256");
  const persisted = JSON.parse(readFileSync(join(providerRoot, "filesystem-write-observation.json"), "utf8"));
  assert.deepEqual(persisted, observation);
  assert.equal(
    existsSync(
      join(
        missionAgentRoot,
        "filesystem-write-denied-probes",
        assignment.executionId,
        `1-1-${sha256(canonicalJson({ acceptanceRunId: authority.acceptanceRunId, candidateArtifactSha256: authority.candidateArtifactSha256, assignmentId: assignment.assignmentId, assignmentAttempt: assignment.attempt, providerAttemptId: "1-1", authoritySha256: authority.authoritySha256 })).slice(0, 24)}.denied`,
      ),
    ),
    false,
  );
  assert.equal(
    existsSync(
      join(
        worktree,
        `.mission-agent-filesystem-probe-${sha256(canonicalJson({ acceptanceRunId: authority.acceptanceRunId, candidateArtifactSha256: authority.candidateArtifactSha256, assignmentId: assignment.assignmentId, assignmentAttempt: assignment.attempt, providerAttemptId: "1-1", authoritySha256: authority.authoritySha256 })).slice(0, 24)}`,
      ),
    ),
    false,
  );
  messages.length = 0;
  await probe.spawnProviderAfterFilesystemBoundary(
    {},
    assignment,
    {
      filesystemWriteAuthority: authority,
      providerAttemptId: "1-1",
      workingDirectory: worktree,
      temporaryDirectory: providerRoot,
      profilePath,
      env: { PATH: process.env.PATH },
      runtimeProfileId: authority.runtimeProfileId,
    },
    "codex",
    "gpt-5.6-luna",
    worktree,
    "implementation",
  );
  assert.equal(providerSpawned, true, "expected denial continues to the post-probe provider spawn boundary");
  assert.equal(messages.length, 2);
});

test("filesystem observation secret predicate accepts long evidence and rejects actual secret material", () => {
  const longNonSecretObservation = canonicalJson({
    schemaVersion: "filesystem-write-observation/1",
    approvedWritableRoot: join(process.env.HOME ?? "/private/tmp", "governed-worktree"),
    boundedEvidence: "x".repeat(2_000),
  });
  assert.equal(longNonSecretObservation.length > 1_000, true);
  assert.equal(filesystemObservationContainsProhibitedSecret(longNonSecretObservation), false);
  assert.equal(
    filesystemObservationContainsProhibitedSecret(
      canonicalJson({ authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345" }),
    ),
    true,
  );
  const exactSecret = "fixture-sensitive-value-0123456789";
  assert.equal(
    filesystemObservationContainsProhibitedSecret(canonicalJson({ opaqueValue: exactSecret }), [exactSecret]),
    true,
  );
});

test("server boundary executably rejects every required sealed observation mutation", () => {
  const fixtureRoot = resolve(tmpdir(), `filesystem-observation-binding-${randomUUID()}`);
  const worktree = join(fixtureRoot, "worktree");
  const outside = join(fixtureRoot, "outside", "denied");
  const workspaceId = randomUUID();
  const missionId = randomUUID();
  const executionId = randomUUID();
  const assignmentId = randomUUID();
  const authority = {
    candidateArtifactSha256: "a".repeat(64),
    providerAttemptId: "1-1",
    provider: "codex",
    model: "gpt-5.6-luna",
    runtimeProfileId: "codex-implementation-macos-v2",
    approvedWritableRoots: [worktree],
    authoritySha256: "b".repeat(64),
  };
  const baseUnsigned = {
    schemaVersion: "filesystem-write-observation/1",
    observationSchemaIdentitySha256: "c".repeat(64),
    acceptanceRunId: workspaceId,
    candidateArtifactSha256: authority.candidateArtifactSha256,
    missionId,
    executionId,
    assignmentId,
    assignmentAttempt: 1,
    providerAttemptId: "1-1",
    provider: authority.provider,
    model: authority.model,
    runtimeProfileId: authority.runtimeProfileId,
    approvedWritableRoots: authority.approvedWritableRoots,
    requestedTargetCanonicalPath: outside,
    operation: "create",
    existsBefore: false,
    errorClassification: "provider_filesystem_write_forbidden",
    reasonCode: "FILESYSTEM_WRITE_FORBIDDEN",
    existsAfter: false,
    targetSha256: null,
    authoritySha256: authority.authoritySha256,
    allowedWrite: { allowed: true, existsAfter: true },
    deniedWrite: {
      canonicalTargetPath: outside,
      allowed: false,
      reasonCode: "FILESYSTEM_WRITE_FORBIDDEN",
      existedBefore: false,
      existsAfter: false,
      targetSha256Before: null,
      targetSha256After: null,
    },
    descendantWrite: {
      attempted: true,
      allowed: false,
      targetExistsAfter: false,
      reasonCode: "FILESYSTEM_WRITE_FORBIDDEN",
    },
  };
  const seal = (unsigned) => {
    const observationIdentitySha256 = sha256(canonicalJson(unsigned));
    return {
      ...unsigned,
      observationIdentitySha256,
      evidenceSeal: { algorithm: "sha256", subjectSha256: observationIdentitySha256 },
    };
  };
  const expected = {
    authority,
    registeredAuthoritySha256: authority.authoritySha256,
    workspaceId,
    missionId,
    executionId,
    assignmentId,
    assignmentAttempt: 1,
  };
  assert.doesNotThrow(() => assertFilesystemWriteObservationBinding({ ...expected, observation: seal(baseUnsigned) }));
  const mutations = [
    { reasonCode: "OTHER" },
    {
      requestedTargetCanonicalPath: join(worktree, "inside"),
      deniedWrite: { ...baseUnsigned.deniedWrite, canonicalTargetPath: join(worktree, "inside") },
    },
    { existsAfter: true },
    { acceptanceRunId: randomUUID() },
    { candidateArtifactSha256: "d".repeat(64) },
    { assignmentId: randomUUID() },
    { providerAttemptId: "1-2" },
    { authoritySha256: "e".repeat(64) },
  ];
  for (const mutation of mutations)
    assert.throws(() =>
      assertFilesystemWriteObservationBinding({ ...expected, observation: seal({ ...baseUnsigned, ...mutation }) }),
    );
  const unsealed = seal(baseUnsigned);
  delete unsealed.evidenceSeal;
  assert.throws(() => assertFilesystemWriteObservationBinding({ ...expected, observation: unsealed }));
});
