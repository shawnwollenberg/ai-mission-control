import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NAMED_CANARY_ID,
  NODE_ARCHIVE_SHA256,
  NODE_ARCHIVE_URL,
  NODE_EXECUTABLE,
  NODE_EXECUTABLE_SHA256,
  REPLACEMENT_BOOTSTRAP_PROTOCOL,
  SOURCE_SHA256,
  TARGET_LENGTH,
  TARGET_SHA256,
  authorizationChecksum,
  assertReplacementEligible,
  createReplacementRecord,
  executeAtomicReplacement,
  renderLaunchAgent,
  recoverInterruptedReplacement,
  stageAtomicReplacement,
  transitionReplacement,
  validateNodeRuntimePlan,
  validateReplacementAuthorization,
  verifyReplacementRelease,
} from "../integrations/mission-agent/replacement-bootstrap.ts";
import { canonicalJson } from "../integrations/mission-agent/release-authority.ts";

const authorization = JSON.parse(
  await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8"),
);
const now = new Date("2026-07-28T00:00:00.000Z");
const evidenceChecksum = "a".repeat(64);
let sequence = 0;
const transition = (record, to) =>
  transitionReplacement(record, {
    expectedVersion: record.version,
    to,
    eventId: `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
    evidenceChecksum,
    occurredAt: new Date(now.getTime() + sequence * 1000).toISOString(),
    operatorIdentity: to === "approved" ? authorization.approvedBy : authorization.operatorIdentity,
  });
const approvedRecord = () => transition(createReplacementRecord(authorization, { now }), "approved").record;
const replacingRecord = () => {
  let record = approvedRecord();
  for (const state of ["draining", "verified", "staged", "replacing"]) record = transition(record, state).record;
  return record;
};

test("authorization binds one human-approved agent, source, target, runtime, expiry, and use", () => {
  const validated = validateReplacementAuthorization(authorization, { now });
  assert.equal(validated.protocolVersion, REPLACEMENT_BOOTSTRAP_PROTOCOL);
  assert.equal(validated.agentId, NAMED_CANARY_ID);
  assert.equal(validated.currentArtifactSha256, SOURCE_SHA256);
  assert.equal(validated.targetArtifactSha256, TARGET_SHA256);
  assert.equal(validated.targetArtifactByteLength, TARGET_LENGTH);
  assert.equal(validated.maximumExecutionCount, 1);
  assert.match(authorizationChecksum(validated), /^[a-f0-9]{64}$/);
  assert.equal(validated.legacyCryptographicContinuity, "unavailable");
});

test("authorization mutation matrix fails closed", () => {
  const mutations = [
    { agentId: "00000000-0000-4000-8000-000000000000" },
    { hostIdentity: "" },
    { currentVersion: "0.6.7" },
    { currentArtifactSha256: "b".repeat(64) },
    { targetVersion: "0.7.1" },
    { targetArtifactSha256: "b".repeat(64) },
    { targetArtifactByteLength: 1 },
    { targetManifestSha256: "b".repeat(64) },
    { targetSignatureSha256: "b".repeat(64) },
    { targetSigningKeyId: "mission-agent-release-2026-00" },
    { targetPublicKeyFingerprint: `ed25519-spki-sha256:${"b".repeat(64)}` },
    { requiredNodeVersion: "24.10.0" },
    { approvedBy: "" },
    { maximumExecutionCount: 2 },
    { rollbackVersion: "0.6.7" },
    { reason: "ordinary-update" },
    { legacyCryptographicContinuity: "available" },
    { evidenceReferences: [] },
  ];
  for (const mutation of mutations)
    assert.throws(() => validateReplacementAuthorization({ ...authorization, ...mutation }, { now }));
  assert.throws(() =>
    validateReplacementAuthorization({ ...authorization, expiresAt: "2026-07-27T23:00:00.000Z" }, { now }),
  );
});

test("state machine is checksummed, compare-and-set, single-use, and terminal", () => {
  let record = createReplacementRecord(authorization, { now });
  const path = [
    "approved",
    "draining",
    "verified",
    "staged",
    "replacing",
    "starting",
    "connected",
    "accepted",
    "completed",
  ];
  const events = [];
  for (const state of path) {
    const result = transition(record, state);
    record = result.record;
    events.push(result.event);
  }
  assert.equal(record.state, "completed");
  assert.equal(record.executionCount, 1);
  assert.ok(record.consumedAt);
  assert.equal(new Set(events.map((event) => event.checksum)).size, events.length);
  assert.throws(() => transition(record, "replacing"));
  assert.throws(() =>
    transitionReplacement(approvedRecord(), {
      expectedVersion: 99,
      to: "draining",
      eventId: "00000000-0000-4000-8000-999999999999",
      evidenceChecksum,
      occurredAt: now.toISOString(),
      operatorIdentity: authorization.operatorIdentity,
    }),
  );
  assert.throws(() =>
    transitionReplacement(approvedRecord(), {
      expectedVersion: 2,
      to: "draining",
      eventId: "00000000-0000-4000-8000-999999999998",
      evidenceChecksum,
      occurredAt: now.toISOString(),
      operatorIdentity: "unauthenticated-operator",
    }),
  );
});

test("rollback is explicit, terminal, and never retries replacement", () => {
  let record = approvedRecord();
  for (const state of [
    "draining",
    "verified",
    "staged",
    "replacing",
    "starting",
    "failed",
    "rolling_back",
    "rolled_back",
  ])
    record = transition(record, state).record;
  assert.equal(record.state, "rolled_back");
  assert.equal(record.executionCount, 1);
  assert.throws(() => transition(record, "replacing"));
});

test("canary-scoped eligibility rejects identity, health, drain, lease, duplicate, and replay mismatches", () => {
  const record = approvedRecord();
  const eligible = {
    record,
    agentId: authorization.agentId,
    hostIdentity: authorization.hostIdentity,
    currentVersion: authorization.currentVersion,
    currentArtifactSha256: authorization.currentArtifactSha256,
    workspaceId: authorization.workspaceId,
    repositoryId: authorization.repositoryId,
    repositoryFingerprint: authorization.repositoryFingerprint,
    healthy: true,
    drained: true,
    activeMission: false,
    activeLease: false,
    duplicateActiveAuthorizations: 1,
    now,
  };
  assert.doesNotThrow(() => assertReplacementEligible(eligible));
  for (const mutation of [
    { agentId: "other" },
    { hostIdentity: "other" },
    { currentVersion: "0.7.2" },
    { currentArtifactSha256: "b".repeat(64) },
    { workspaceId: "00000000-0000-4000-8000-000000000000" },
    { repositoryId: "00000000-0000-4000-8000-000000000000" },
    { repositoryFingerprint: "b".repeat(64) },
    { healthy: false },
    { drained: false },
    { activeMission: true },
    { activeLease: true },
    { duplicateActiveAuthorizations: 0 },
    { duplicateActiveAuthorizations: 2 },
  ])
    assert.throws(() => assertReplacementEligible({ ...eligible, ...mutation }));
  assert.throws(() => assertReplacementEligible({ ...eligible, record: { ...record, state: "completed" } }));
});

test("exact Manifest v3 and artifact verify through Mission Control and standalone Ed25519", async () => {
  const signedManifestText = await readFile("release/mission-agent-0.7.2/signed-manifest-v3.json", "utf8");
  const artifact = await readFile("public/mission-agent-0.7.2.mjs");
  const result = verifyReplacementRelease({ signedManifestText, artifact, now });
  assert.equal(result.artifactChecksum, TARGET_SHA256);
  assert.equal(result.standaloneVerified, true);
});

test("target verification negative matrix fails closed", async () => {
  const signedManifestText = await readFile("release/mission-agent-0.7.2/signed-manifest-v3.json", "utf8");
  const artifact = await readFile("public/mission-agent-0.7.2.mjs");
  const signed = JSON.parse(signedManifestText);
  for (const mutation of [
    { manifestVersion: "2" },
    { releaseAuthorityVersion: "v1" },
    { signingKeyId: "mission-agent-release-2026-00" },
    { publicKeyFingerprint: `ed25519-spki-sha256:${"b".repeat(64)}` },
    { artifactSha256: "b".repeat(64) },
    { artifactByteLength: 1 },
    { platform: { ...signed.platform, runtimeMajorVersion: 24 } },
    { platform: { ...signed.platform, operatingSystem: "windows" } },
    { platform: { ...signed.platform, architecture: "x64" } },
    { compatibility: { ...signed.compatibility, identityProtocolVersion: "1" } },
    { build: { ...signed.build, sourceCommit: "b".repeat(40) } },
    { expiresAt: "2026-07-27T20:00:01.000Z" },
    { signature: Buffer.alloc(64).toString("base64") },
  ]) {
    const text = JSON.stringify({ ...signed, ...mutation });
    assert.throws(() => verifyReplacementRelease({ signedManifestText: text, artifact, now }));
  }
  assert.throws(() => verifyReplacementRelease({ signedManifestText, artifact: Buffer.from("partial"), now }));
});

test("Node 22 plan pins provider, archive, absolute executable, version, mode, and rejects ambiguous runtime", () => {
  const valid = {
    archiveUrl: NODE_ARCHIVE_URL,
    archiveSha256: NODE_ARCHIVE_SHA256,
    executablePath: NODE_EXECUTABLE,
    reportedVersion: "v22.22.0",
    executableSha256: NODE_EXECUTABLE_SHA256,
    executableMode: 0o755,
  };
  assert.doesNotThrow(() => validateNodeRuntimePlan(valid));
  for (const mutation of [
    { archiveUrl: "https://example.com/node.tgz" },
    { archiveSha256: "b".repeat(64) },
    { executablePath: "node" },
    { executablePath: "/usr/local/bin/node" },
    { reportedVersion: "v24.10.0" },
    { executableSha256: "bad" },
    { executableMode: 0o644 },
  ])
    assert.throws(() => validateNodeRuntimePlan({ ...valid, ...mutation }));
});

test("launchd definition uses only absolute pinned Node 22 and preserved paths", () => {
  const plist = renderLaunchAgent({
    nodeExecutable: NODE_EXECUTABLE,
    agentArtifact: "/Users/fixture/.mission-agent/mission-agent-0.7.2.mjs",
    agentHome: "/Users/fixture/.mission-agent",
    stdoutPath: "/Users/fixture/.mission-agent/mission-agent.log",
    stderrPath: "/Users/fixture/.mission-agent/mission-agent-error.log",
  });
  assert.match(plist, new RegExp(NODE_EXECUTABLE));
  assert.doesNotMatch(plist, /\/usr\/local\/bin\/node|<string>node<\/string>/);
  assert.throws(() =>
    renderLaunchAgent({
      nodeExecutable: "node",
      agentArtifact: "agent.mjs",
      agentHome: ".mission-agent",
      stdoutPath: "out",
      stderrPath: "err",
    }),
  );
});

test("atomic staging preserves rollback bytes and verifies target before rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "replacement-bootstrap-"));
  const oldArtifact = join(root, "mission-agent-0.6.8.mjs");
  const oldPlist = join(root, "old.plist");
  await writeFile(oldArtifact, await readFile("public/mission-agent-0.6.8.mjs"), { mode: 0o700 });
  await writeFile(oldPlist, "old-service", { mode: 0o600 });
  const launchAgent = renderLaunchAgent({
    nodeExecutable: NODE_EXECUTABLE,
    agentArtifact: join(root, "mission-agent-0.7.2.mjs"),
    agentHome: root,
    stdoutPath: join(root, "out.log"),
    stderrPath: join(root, "err.log"),
  });
  const staged = await stageAtomicReplacement({
    root,
    artifact: await readFile("public/mission-agent-0.7.2.mjs"),
    launchAgent,
    existingArtifact: oldArtifact,
    existingLaunchAgent: oldPlist,
  });
  assert.equal((await stat(staged.stagedArtifact)).size, TARGET_LENGTH);
  assert.deepEqual(
    await readFile(join(staged.rollbackDirectory, "mission-agent-0.6.8.mjs")),
    await readFile(oldArtifact),
  );
  await assert.rejects(() =>
    stageAtomicReplacement({
      root: join(root, "bad"),
      artifact: Buffer.from("partial"),
      launchAgent,
      existingArtifact: oldArtifact,
      existingLaunchAgent: oldPlist,
    }),
  );
});

test("executor atomically activates the exact target and restores 0.6.8 on failed acceptance", async () => {
  const signedManifestText = await readFile("release/mission-agent-0.7.2/signed-manifest-v3.json", "utf8");
  const artifact = await readFile("public/mission-agent-0.7.2.mjs");
  for (const accepted of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), `replacement-executor-${accepted}-`));
    const activeArtifact = join(root, "mission-agent-active.mjs");
    const activeLaunchAgent = join(root, "com.wallyweb.mission-agent.plist");
    await writeFile(activeArtifact, await readFile("public/mission-agent-0.6.8.mjs"), { mode: 0o700 });
    await writeFile(activeLaunchAgent, "legacy-launch-agent", { mode: 0o600 });
    const launchAgent = renderLaunchAgent({
      nodeExecutable: NODE_EXECUTABLE,
      agentArtifact: join(root, "mission-agent-0.7.2.mjs"),
      agentHome: root,
      stdoutPath: join(root, "out.log"),
      stderrPath: join(root, "err.log"),
    });
    let starts = 0;
    const invocation = executeAtomicReplacement({
      record: replacingRecord(),
      signedManifestText,
      artifact,
      activeArtifact,
      activeLaunchAgent,
      stagingRoot: join(root, "bootstrap"),
      launchAgent,
      verifyNodeRuntime: async () => {},
      service: {
        async stopNamedAgent(agentId) {
          assert.equal(agentId, NAMED_CANARY_ID);
        },
        async verifyStopped() {
          return true;
        },
        async startNamedAgent() {
          starts += 1;
        },
        async verifyAccepted(binding) {
          assert.equal(binding.agentId, authorization.agentId);
          assert.equal(binding.workspaceId, authorization.workspaceId);
          assert.equal(binding.repositoryFingerprint, authorization.repositoryFingerprint);
          return accepted;
        },
      },
    });
    if (accepted) {
      await invocation;
      assert.equal(authorizationChecksum(authorization).length, 64);
      assert.deepEqual(await readFile(activeArtifact), artifact);
      assert.equal(starts, 1);
    } else {
      await assert.rejects(invocation);
      assert.deepEqual(await readFile(activeArtifact), await readFile("public/mission-agent-0.6.8.mjs"));
      assert.equal(await readFile(activeLaunchAgent, "utf8"), "legacy-launch-agent");
      assert.equal(starts, 2);
    }
  }
});

test("durable host journal recovers an interruption between artifact and service activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "replacement-recovery-"));
  const stagingRoot = join(root, "bootstrap");
  const activeArtifact = join(root, "mission-agent-active.mjs");
  const activeLaunchAgent = join(root, "com.wallyweb.mission-agent.plist");
  await writeFile(activeArtifact, await readFile("public/mission-agent-0.6.8.mjs"), { mode: 0o700 });
  await writeFile(activeLaunchAgent, "legacy-launch-agent", { mode: 0o600 });
  const staged = await stageAtomicReplacement({
    root: stagingRoot,
    artifact: await readFile("public/mission-agent-0.7.2.mjs"),
    launchAgent: "replacement-launch-agent",
    existingArtifact: activeArtifact,
    existingLaunchAgent: activeLaunchAgent,
  });
  await writeFile(activeArtifact, await readFile("public/mission-agent-0.7.2.mjs"), { mode: 0o700 });
  const unsignedJournal = {
    protocolVersion: REPLACEMENT_BOOTSTRAP_PROTOCOL,
    agentId: NAMED_CANARY_ID,
    authorizationChecksum: replacingRecord().authorizationChecksum,
    phase: "artifact_installed",
    activeArtifact,
    activeLaunchAgent,
    rollbackDirectory: staged.rollbackDirectory,
  };
  const checksum = createHash("sha256").update(canonicalJson(unsignedJournal)).digest("hex");
  await writeFile(
    join(stagingRoot, "replacement-host-journal.json"),
    `${canonicalJson({ ...unsignedJournal, checksum })}\n`,
    { mode: 0o600 },
  );
  let started = 0;
  const result = await recoverInterruptedReplacement({
    record: replacingRecord(),
    activeArtifact,
    activeLaunchAgent,
    stagingRoot,
    service: {
      async stopNamedAgent() {},
      async verifyStopped() {
        return true;
      },
      async startNamedAgent() {
        started += 1;
      },
      async verifyAccepted() {
        return false;
      },
    },
  });
  assert.equal(result, "rolled_back");
  assert.deepEqual(await readFile(activeArtifact), await readFile("public/mission-agent-0.6.8.mjs"));
  assert.equal(await readFile(activeLaunchAgent, "utf8"), "legacy-launch-agent");
  assert.equal(started, 1);
});

test("ordinary fleet discovery remains unchanged and proposed durable schema is canary-scoped", async () => {
  const latest = JSON.parse(await readFile("public/mission-agent-latest.json", "utf8"));
  assert.equal(latest.releaseVersion, "0.7.2");
  assert.equal(latest.manifestVersion, "3");
  const source = await readFile("db/migrations/0029_mission_agent_replacement_bootstrap.sql", "utf8");
  assert.match(source, /mission_agent_replacement_bootstraps/);
  assert.match(source, /execution_count BETWEEN 0 AND 1/);
  assert.match(source, /mission_agent_replacement_active_agent_idx/);
  assert.match(source, /UNIQUE\(workspace_id,authorization_id,aggregate_version\)/);
  assert.doesNotMatch(source, /UPDATE agents|UPDATE repositories|mission-agent-latest/);
  const operatorStore = await readFile("application/mission-agent-replacement-bootstrap.ts", "utf8");
  assert.match(operatorStore, /SELECT clock_timestamp\(\) AS now/);
  assert.doesNotMatch(operatorStore, /executionContext\.now|occurredAt: string/);
});
