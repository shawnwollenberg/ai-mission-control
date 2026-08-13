import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { assertFilesystemWriteObservationBinding } from "../application/remote-agent-messages.ts";

const run = promisify(execFile);
const runtime = resolve("scripts/mock-provider-runtime.mjs");

test("mission agent binds mock authorization to the governed nested artifact identity", async () => {
  const source = await readFile("scripts/mission-agent-080.template.mjs", "utf8");
  assert.match(source, /authorization\.artifact\?\.sha256 !== sha256\(await readFile\(scriptPath\)\)/);
  assert.match(
    source,
    /const model = assignment\.consensus\?\.selectedModel \?\? assignment\.approvedPlan\?\.selectedModel/,
  );
  assert.match(
    source,
    /authorization\.artifact\?\.capabilityManifestSha256 !== sha256\(runtimeCapabilityManifestBytes\)/,
  );
  assert.doesNotMatch(source, /authorization\.candidateArtifactSha256/);
  assert.doesNotMatch(source, /capabilityManifest\.acceptanceContractCanonicalSha256/);
  assert.match(source, /profilePath: mockSandboxProfilePath/);
  assert.doesNotMatch(source, /profilePath: authorizationPath/);
  assert.match(source, /runtimeProfileHash: runtimeProfile\.runtimeBindingHash/);
  assert.doesNotMatch(source, /runtimeProfileId: `mock-/);
  assert.match(source, /enum: \[template\.source_artifact_ids\]/);
  assert.match(source, /deny file-read\* \(require-all \(subpath/);
  assert.match(source, /deny file-write\* \(require-all/);
  assert.match(source, /\.\.\.pathEntries\.map\(\(path\) => dirname\(path\)\)/);
  assert.match(source, /require-not \(literal \$\{JSON\.stringify\(realpathSync\(homedir\(\)\)\)\}\)/);
});

test("acceptance harness paces one-shot agents within the production heartbeat budget", async () => {
  const source = await readFile("scripts/run-consensus-real-acceptance.ts", "utf8");
  assert.match(source, /const minimumSpacingMs = 21_000/);
  assert.match(source, /await awaitAgentHeartbeatBudget\(agent\.agentId\)/);
  assert.match(source, /Human approval projection did not expose its durable approval identity/);
  assert.doesNotMatch(source, /DELETE FROM protocol_rate_limits/);
  assert.match(source, /p\.attempt AS lease_sequence/);
  assert.doesNotMatch(source, /p\.lease_sequence/);
  assert.match(source, /Child implementation failed:/);
});

test("mock canonical plans use the exact owner-governed validation command", async () => {
  const source = await readFile("scripts/mock-provider-runtime.mjs", "utf8");
  assert.match(source, /output\.validation_plan = \["npm test"\]/);
  assert.doesNotMatch(source, /Verify the durable result and repository authority/);
});

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};
const invocation = (overrides = {}) => {
  const { authorityApprovedWritableRoots, ...contextOverrides } = overrides;
  const base = {
    schemaVersion: "mission-agent-mock-provider-invocation/1",
    evidenceSource: "mock_provider_runtime",
    authenticatedProviderInvoked: false,
    productionAuthority: false,
    mockProvider: "mock_claude_code",
    requestedProvider: "claude_code",
    requestedModel: "claude-fable-5",
    expectedModel: "claude-fable-5",
    acceptanceRunId: "00000000-0000-4000-8000-000000000010",
    workspaceId: "00000000-0000-4000-8000-000000000010",
    missionId: "00000000-0000-4000-8000-000000000002",
    executionId: "00000000-0000-4000-8000-000000000003",
    assignmentId: "00000000-0000-4000-8000-000000000001",
    expectedAssignmentId: "00000000-0000-4000-8000-000000000001",
    attemptId: 1,
    runtimeProfile: "claude-planning-macos-v2",
    repositorySnapshot: "a".repeat(64),
    expectedRepositorySnapshot: "a".repeat(64),
    contextHash: "b".repeat(64),
    expectedContextHash: "b".repeat(64),
    fencingToken: 1,
    expectedFencingToken: 1,
    providerAttemptId: "1-1",
    ...contextOverrides,
  };
  const authorityUnsigned = {
    schemaVersion: "filesystem-write-authority/1",
    acceptanceRunId: base.acceptanceRunId,
    candidateArtifactSha256: "a".repeat(64),
    workspaceId: base.workspaceId,
    missionId: base.missionId,
    childMissionId: base.missionId,
    executionId: base.executionId,
    assignmentId: base.assignmentId,
    assignmentAttempt: base.attemptId,
    providerAttemptId: base.providerAttemptId,
    agentId: "00000000-0000-4000-8000-000000000004",
    provider: base.requestedProvider,
    model: base.requestedModel,
    runtimeProfileId: base.runtimeProfile,
    repositoryId: "00000000-0000-4000-8000-000000000005",
    repositorySnapshotSha256: base.repositorySnapshot,
    worktreeIdentitySha256: "c".repeat(64),
    approvedWritableRoots: (authorityApprovedWritableRoots ?? [tmpdir(), process.cwd()]).sort(),
    readOnlyRoots: [],
    temporaryRoot: tmpdir(),
    sandboxRoot: tmpdir(),
    artifactStagingRoot: null,
  };
  return Buffer.from(
    JSON.stringify({
      ...base,
      filesystemWriteAuthority: {
        ...authorityUnsigned,
        authoritySha256: createHash("sha256").update(canonicalJson(authorityUnsigned)).digest("hex"),
      },
    }),
  ).toString("base64url");
};
const env = (overrides = {}) => ({
  APP_ENV: "disposable_acceptance",
  MISSION_AGENT_PROVIDER_RUNTIME_MODE: "mock_provider_acceptance",
  MISSION_AGENT_MOCK_INVOCATION: invocation(),
  ...overrides,
});

test("mock runtime is impossible outside explicit disposable acceptance", async () => {
  await assert.rejects(run(process.execPath, [runtime], { env: env({ APP_ENV: "production" }) }), /acceptance-only/);
  await assert.rejects(
    run(process.execPath, [runtime], { env: env({ MISSION_AGENT_PROVIDER_RUNTIME_MODE: "real_provider_acceptance" }) }),
    /not explicit/,
  );
});

test("mock runtime emits a machine-readable provider authentication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "mock-provider-auth-"));
  await assert.rejects(
    run(process.execPath, [runtime], {
      env: env({ MISSION_AGENT_MOCK_SCENARIO: "provider_authentication_failure" }),
      cwd: root,
    }),
    (error) => {
      const observation = JSON.parse(error.stdout);
      assert.equal(observation.type, "result");
      assert.equal(observation.is_error, true);
      assert.equal(observation.terminal_reason, "api_error");
      assert.equal(observation.api_error_status, 401);
      assert.equal(observation.error_code, "oauth_token_expired");
      return true;
    },
  );
  await rm(root, { recursive: true, force: true });
});

test("mock structured runtime preserves bindings and resolves a substantive objection", async () => {
  const root = await mkdtemp(join(tmpdir(), "mock-provider-runtime-"));
  const schema = {
    type: "object",
    required: ["schema_version", "mission_id", "assignment_id", "blocking_objections", "verdict", "confidence"],
    properties: {
      schema_version: { type: "string", enum: ["consensus-plan-critique/1"] },
      mission_id: { type: "string", enum: ["00000000-0000-4000-8000-000000000002"] },
      assignment_id: { type: "string", enum: ["00000000-0000-4000-8000-000000000001"] },
      blocking_objections: { type: "array", items: { type: "object" } },
      verdict: { type: "string", enum: ["accept_with_changes"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
  };
  const result = await run(process.execPath, [runtime, "--print", "--json-schema", JSON.stringify(schema)], {
    env: env(),
    cwd: root,
  });
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.evidence_source, "mock_provider_runtime");
  assert.equal(envelope.authenticated_provider_invoked, false);
  assert.equal(envelope.mock_provider_identity, "mock_claude_code");
  assert.equal(envelope.structured_output.blocking_objections[0].id, "mock-objection-validation");
});

test("mock implementation uses a subprocess-visible worktree effect and no provider credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "mock-provider-change-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "consensus-acceptance-fixture", type: "module", scripts: { test: "node --test" } }),
  );
  await writeFile(
    join(root, "src", "retention.js"),
    'const RETENTION_DAYS = Object.freeze({ critical: 30, standard: 7 });\n\nexport function currentRetentionDays(tier) {\n  if (typeof tier !== "string" || !Object.hasOwn(RETENTION_DAYS, tier)) throw new TypeError("tier must be an explicitly supported retention tier");\n  return RETENTION_DAYS[tier];\n}\n',
  );
  const result = await run(process.execPath, [runtime, "--print"], { env: env(), cwd: root });
  assert.match(result.stdout, /no authenticated provider was invoked/i);
  assert.match(await readFile(join(root, ".mission-control-mock-implementation.txt"), "utf8"), /assignment=/);
  assert.match(await readFile(join(root, "src", "retention.js"), "utf8"), /recommendRetentionPolicy/);
  const retention = await import(`${pathToFileURL(join(root, "src", "retention.js")).href}?v=${Date.now()}`);
  assert.equal(retention.recommendRetentionPolicy({ tier: "critical" }).days, 30);
  assert.equal(retention.recommendRetentionPolicy({ tier: "standard" }).days, 7);
  for (const tier of ["unknown", undefined, null, 1, {}, [], true])
    assert.throws(() => retention.recommendRetentionPolicy({ tier }), TypeError);
  assert.throws(() => retention.recommendRetentionPolicy(), TypeError);
  assert.match(await readFile(join(root, "test", "retention.test.js"), "utf8"), /within bounds/);
  const validation = await run("npm", ["test"], { cwd: root });
  assert.match(validation.stdout, /node --test/);
});

test("named fault scenarios fail without arbitrary mutation hooks", async () => {
  await assert.rejects(
    run(process.execPath, [runtime], {
      env: env({ MISSION_AGENT_MOCK_SCENARIO: "stale_fencing" }),
    }),
    /stale_fencing/,
  );
});

test("provider restart fault creates two real process generations and only replacement output", async () => {
  const root = await mkdtemp(join(tmpdir(), "mock-provider-restart-"));
  const schema = {
    type: "object",
    properties: {
      schema_version: { type: "string", enum: ["canonical-plan-verdict/1"] },
      verdict: { type: "string", enum: ["approve"] },
      confidence: { type: "number", minimum: 0 },
    },
  };
  const restartEnv = env({
    MISSION_AGENT_MOCK_SCENARIO: "provider_restart_once",
    MISSION_AGENT_MOCK_SCENARIO_STATE_ROOT: root,
    MISSION_AGENT_MOCK_INVOCATION: invocation({ providerAttemptId: "1-1" }),
  });
  const first = spawn(process.execPath, [runtime, "--print", "--json-schema", JSON.stringify(schema)], {
    env: restartEnv,
    cwd: root,
  });
  const [firstCode, firstSignal] = await once(first, "close");
  const contamination = join(root, ".provider-generation-1-contamination");
  assert.match(await readFile(contamination, "utf8"), /failed provider generation/);
  await rm(contamination);
  const replacementEnv = {
    ...restartEnv,
    MISSION_AGENT_MOCK_INVOCATION: invocation({ providerAttemptId: "1-2" }),
  };
  const replacement = spawn(process.execPath, [runtime, "--print", "--json-schema", JSON.stringify(schema)], {
    env: replacementEnv,
    cwd: root,
  });
  let replacementStdout = "";
  replacement.stdout.on("data", (chunk) => (replacementStdout += String(chunk)));
  const [replacementCode, replacementSignal] = await once(replacement, "close");
  assert.notEqual(first.pid, replacement.pid);
  assert.equal(firstCode, null);
  assert.equal(firstSignal, "SIGKILL");
  assert.equal(replacementCode, 0);
  assert.equal(replacementSignal, null);
  assert.equal(JSON.parse(replacementStdout).structured_output.verdict, "approve");
  assert.deepEqual(
    JSON.parse(
      await readFile(
        join(
          root,
          `${JSON.parse(Buffer.from(restartEnv.MISSION_AGENT_MOCK_INVOCATION, "base64url").toString()).assignmentId}-replacement-observed-clean-worktree`,
        ),
        "utf8",
      ),
    ),
    { providerAttemptId: "1-2", contaminationAbsent: true },
  );
});

test("sandboxed executor records write evidence before controlled restart termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "mock-provider-sandbox-restart-"));
  const providerRoot = join(root, "provider");
  const deniedRoot = await mkdtemp(join(tmpdir(), "mock-provider-denied-"));
  await mkdir(providerRoot);
  const canonicalRoot = await realpath(root);
  const canonicalProviderRoot = await realpath(providerRoot);
  const observationPath = join(providerRoot, "filesystem-write-observation.json");
  const context = invocation({
    role: "executor",
    operation: "implementation",
    attemptId: 1,
    providerAttemptId: "1-1",
    authorityApprovedWritableRoots: [canonicalRoot, canonicalProviderRoot],
    filesystemWriteProbe: {
      allowedPath: join(root, "allowed.txt"),
      deniedPath: join(deniedRoot, "denied.txt"),
      observationPath,
    },
  });
  const profile = join(root, "sandbox.sb");
  await writeFile(
    profile,
    `(version 1)\n(deny default)\n(allow process*)\n(allow file-read*)\n(allow file-read-metadata)\n(allow sysctl-read)\n(allow mach-lookup)\n(allow file-write* (subpath "${canonicalRoot}"))\n`,
  );
  const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, runtime], {
    cwd: root,
    env: env({
      MISSION_AGENT_MOCK_INVOCATION: context,
      MISSION_AGENT_MOCK_SCENARIO: "provider_restart_once",
      MISSION_AGENT_MOCK_SCENARIO_STATE_ROOT: root,
    }),
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const terminal = await once(child, "close");
  assert.equal(terminal[0], null, stderr);
  assert.equal(terminal[1], "SIGKILL", stderr);
  const observation = JSON.parse(await readFile(observationPath, "utf8"));
  const parsedContext = JSON.parse(Buffer.from(context, "base64url").toString("utf8"));
  assert.equal(observation.deniedWrite.existsAfter, false);
  assert.equal(observation.deniedWrite.existedBefore, false);
  assert.equal(observation.deniedWrite.reasonCode, "FILESYSTEM_WRITE_FORBIDDEN");
  assert.equal(observation.allowedWrite.allowed, true);
  assert.equal(observation.descendantWrite.allowed, false);
  assert.match(observation.observationIdentitySha256, /^[a-f0-9]{64}$/);
  assert.equal(observation.evidenceSeal.subjectSha256, observation.observationIdentitySha256);
  assert.doesNotThrow(() =>
    assertFilesystemWriteObservationBinding({
      observation,
      authority: parsedContext.filesystemWriteAuthority,
      registeredAuthoritySha256: parsedContext.filesystemWriteAuthority.authoritySha256,
      workspaceId: parsedContext.acceptanceRunId,
      missionId: parsedContext.missionId,
      executionId: parsedContext.executionId,
      assignmentId: parsedContext.assignmentId,
      assignmentAttempt: parsedContext.attemptId,
    }),
  );
  const oldShape = { ...observation };
  delete oldShape.observationIdentitySha256;
  delete oldShape.evidenceSeal;
  assert.throws(() =>
    assertFilesystemWriteObservationBinding({
      observation: oldShape,
      authority: parsedContext.filesystemWriteAuthority,
      registeredAuthoritySha256: parsedContext.filesystemWriteAuthority.authoritySha256,
      workspaceId: parsedContext.acceptanceRunId,
      missionId: parsedContext.missionId,
      executionId: parsedContext.executionId,
      assignmentId: parsedContext.assignmentId,
      assignmentAttempt: parsedContext.attemptId,
    }),
  );
});
