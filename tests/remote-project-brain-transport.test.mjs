import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalHash } from "../lib/canonical-json.ts";
import {
  assertCompatibleRemoteProjectBrain,
  validateRemoteProjectBrainCapabilities,
  validateRemoteProjectBrainRequest,
} from "../integrations/project-brain/remote-protocol.ts";

const capabilities = {
  installed: true,
  coreVersion: "0.4.0",
  contractVersions: ["1.0"],
  schemaVersions: ["2.5.0"],
  operations: ["detect_repository", "prepare_context", "record_closure"],
  readOperations: ["detect_repository", "prepare_context"],
  writeOperations: ["prepare_context", "record_closure"],
  maxRequestBytes: 1_000_000,
  maxResultBytes: 5_000_000,
  artifactTransferModes: ["inline_base64"],
  runtimeReady: true,
  diagnosticsStatus: "ready",
};

test("remote capability negotiation fails closed for absence, staleness, and incompatibility", () => {
  const valid = validateRemoteProjectBrainCapabilities(capabilities);
  assert.doesNotThrow(() =>
    assertCompatibleRemoteProjectBrain({
      capabilities: valid,
      advertisedAt: new Date(),
      operation: "prepare_context",
      requiredVersion: "0.4.0",
      requiredContract: "1.0",
      requiredSchemas: ["2.5.0"],
      requestBytes: 100,
      maxOutputBytes: 1000,
    }),
  );
  for (const changed of [
    { capabilities: null, advertisedAt: null },
    { capabilities: valid, advertisedAt: new Date(Date.now() - 301_000) },
    { capabilities: { ...valid, coreVersion: "0.3.0" }, advertisedAt: new Date() },
    { capabilities: { ...valid, runtimeReady: false }, advertisedAt: new Date() },
  ])
    assert.throws(
      () =>
        assertCompatibleRemoteProjectBrain({
          ...changed,
          operation: "prepare_context",
          requiredVersion: "0.4.0",
          requiredContract: "1.0",
          requiredSchemas: ["2.5.0"],
          requestBytes: 100,
          maxOutputBytes: 1000,
        }),
      /dispatch is blocked/,
    );
});

test("remote requests bind identity, locator, expiry, allowlisted operation, and checksum", () => {
  const unsigned = {
    protocolVersion: "1.0",
    requestId: randomUUID(),
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    repositoryId: randomUUID(),
    repositoryLocator: `mission-agent://${"a".repeat(64)}`,
    repositoryFingerprint: "a".repeat(64),
    missionId: null,
    executionId: null,
    operation: "detect_repository",
    arguments: {},
    startingSha: "b".repeat(40),
    requiredProjectBrainVersion: "0.4.0",
    requiredContractVersion: "1.0",
    requiredSchemaVersions: ["2.5.0"],
    approvalId: null,
    approvalFingerprint: "d".repeat(64),
    policyDecision: { action: "project_brain.read", outcome: "allowed", reasons: [] },
    authorization: {
      allowedAgent: true,
      repositoryReadAllowed: true,
      repositoryWriteAllowed: false,
      requiredPermission: "read",
      resourcePermission: true,
      approvalRequired: false,
      approvalExpiresAt: null,
    },
    requestedArtifactTypes: [],
    timeoutMs: 15_000,
    maxOutputBytes: 1_000_000,
    artifactVersioning: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "n".repeat(24),
  };
  unsigned.idempotencyKey = `project-brain:${unsigned.operationId}`;
  const request = {
    ...unsigned,
    requestChecksum: canonicalHash(unsigned),
    missionControlSignature: "c".repeat(64),
  };
  assert.equal(validateRemoteProjectBrainRequest(request).requestId, request.requestId);
  assert.throws(
    () => validateRemoteProjectBrainRequest({ ...request, operation: "arbitrary_shell" }),
    /Invalid remote/,
  );
  assert.throws(
    () => validateRemoteProjectBrainRequest({ ...request, repositoryLocator: "/tmp/checkout" }),
    /Invalid remote/,
  );
  assert.throws(
    () => validateRemoteProjectBrainRequest({ ...request, startingSha: "e".repeat(40) }),
    /checksum mismatch/,
  );
});

test("Mission Agent uses an explicit executable, fixed consumer argv, registered mappings, and no shell", async () => {
  const source = await readFile(new URL("../public/mission-agent-0.6.7.mjs", import.meta.url), "utf8");
  assert.match(source, /config\.projectBrainExecutable/);
  assert.match(source, /"consumer",\s*"--operation"/);
  assert.match(source, /config\.repositories\?\.\[request\.repositoryId\]/);
  assert.match(source, /repository\.projectBrainWriteAllowed !== true/);
  assert.match(source, /shell: false/);
  assert.match(source, /projectBrainReceipts/);
  assert.match(source, /currentRepository\.fingerprint !== repository\.fingerprint/);
  assert.match(source, /projectBrainInFlight:\s*\{[\s\S]*result: null/);
  assert.match(source, /repository:\s*\{\s*id: request\.repositoryId,[\s\S]*checkout_path: request\.repositoryLocator/);
  assert.match(source, /Repository write approval has already been granted for this plan/);
  assert.match(source, /Treat every approval or pause step in the approved plan as already completed/);
  assert.doesNotMatch(source, /changePrompt = `[^`]*\$\{assignment\.instructions\}/);
  assert.doesNotMatch(source, /spawn\([^)]*request\.command/s);
});

test("artifact versioning recovers an arbitrary partial index from exact intent", async () => {
  const checkout = await mkdtemp(join(tmpdir(), "mission-agent-pb-versioning-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: checkout });
  await writeFile(join(checkout, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
  const parentSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  await mkdir(join(checkout, ".project-brain"), { recursive: true });
  const body = Buffer.from("schema_version: 2.5.0\n");
  await writeFile(join(checkout, ".project-brain", "artifact.yaml"), body);
  // Simulate a crash after an unrelated/partial update-index mutation.
  const unrelatedBlob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: checkout,
    input: "unapproved\n",
    encoding: "utf8",
  }).trim();
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${unrelatedBlob},attacker.txt`], {
    cwd: checkout,
  });
  const { finishProjectBrainArtifactVersioning } = await import("../public/mission-agent-0.6.7.mjs");
  const checksums = {
    ".project-brain/artifact.yaml": createHash("sha256").update(body).digest("hex"),
  };
  const artifactCommit = await finishProjectBrainArtifactVersioning(await realpath(checkout), {
    parentSha,
    paths: [".project-brain/artifact.yaml"],
    checksums,
  });
  assert.equal(artifactCommit.parentSha, parentSha);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD^"], { cwd: checkout, encoding: "utf8" }).trim(), parentSha);
  assert.equal(
    execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).trim(),
    ".project-brain/artifact.yaml",
  );
  assert.equal(execFileSync("git", ["ls-files", "attacker.txt"], { cwd: checkout, encoding: "utf8" }).trim(), "");
});

test("durable Project Brain runner writes a restart-readable terminal process result", async () => {
  const agentHome = await mkdtemp(join(tmpdir(), "mission-agent-pb-runner-"));
  const requestId = randomUUID();
  const prefix = join(agentHome, `project-brain-runner-${requestId}`);
  const specPath = `${prefix}.spec.json`;
  const resultPath = `${prefix}.result.json`;
  await writeFile(
    specPath,
    JSON.stringify({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({status:'succeeded'}))"],
      cwd: agentHome,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    }),
    { mode: 0o600 },
  );
  execFileSync(
    process.execPath,
    [
      new URL("../public/mission-agent-0.6.7.mjs", import.meta.url).pathname,
      "internal-project-brain-runner",
      specPath,
      resultPath,
    ],
    { env: { ...process.env, MISSION_AGENT_HOME: agentHome } },
  );
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(JSON.parse(result.stdout).status, "succeeded");
  assert.ok(result.completedEpochMs >= result.startedEpochMs);
});

test("durable runner evidence survives the state-handoff crash window and prevents re-execution", async () => {
  const agentHome = await mkdtemp(join(tmpdir(), "mission-agent-pb-handoff-"));
  const marker = join(agentHome, "invocations.txt");
  const requestId = randomUUID();
  const moduleUrl = new URL("../public/mission-agent-0.6.7.mjs", import.meta.url).href;
  const program = `
    import { appendFileSync } from "node:fs";
    import { runDurableProjectBrainProcess } from ${JSON.stringify(moduleUrl)};
    const args = ["-e", ${JSON.stringify(
      `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n"); process.stdout.write(JSON.stringify({status:"succeeded"}))`,
    )}];
    const first = await runDurableProjectBrainProcess(${JSON.stringify(
      requestId,
    )}, process.execPath, args, ${JSON.stringify(agentHome)}, 5000, 10000, {lost:false});
    const second = await runDurableProjectBrainProcess(${JSON.stringify(
      requestId,
    )}, process.execPath, args, ${JSON.stringify(agentHome)}, 5000, 10000, {lost:false});
    process.stdout.write(JSON.stringify({first:first.exitCode,second:second.exitCode}));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    env: { ...process.env, MISSION_AGENT_HOME: agentHome },
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(output), { first: 0, second: 0 });
  assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
  await readFile(join(agentHome, `project-brain-runner-${requestId}.result.json`), "utf8");
});

test("stale stdout without terminal exit metadata is never synthesized as success", async () => {
  const agentHome = await mkdtemp(join(tmpdir(), "mission-agent-pb-stale-output-"));
  const checkout = await mkdtemp(join(tmpdir(), "mission-agent-pb-stale-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: checkout });
  await writeFile(join(checkout, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
  const requestId = randomUUID();
  const prefix = join(agentHome, `project-brain-runner-${requestId}`);
  await writeFile(
    join(agentHome, "state.json"),
    JSON.stringify({ projectBrainInFlight: { requestId, statusBefore: "", startedEpochMs: Date.now() } }),
    { mode: 0o600 },
  );
  await writeFile(`${prefix}.lock`, "stale\n", { mode: 0o600 });
  await writeFile(`${prefix}.pid`, "99999999\n", { mode: 0o600 });
  await writeFile(`${prefix}.stdout`, JSON.stringify({ status: "succeeded" }), { mode: 0o600 });
  await writeFile(`${prefix}.stderr`, "nonzero failure after stdout\n", { mode: 0o600 });
  const marker = join(agentHome, "fresh-run.txt");
  const moduleUrl = new URL("../public/mission-agent-0.6.7.mjs", import.meta.url).href;
  const program = `
    import { runDurableProjectBrainProcess } from ${JSON.stringify(moduleUrl)};
    const result = await runDurableProjectBrainProcess(
      ${JSON.stringify(requestId)},
      process.execPath,
      ["-e", ${JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fresh"); process.stdout.write(JSON.stringify({status:"fresh"}))`,
      )}],
      ${JSON.stringify(checkout)},
      5000,
      10000,
      {lost:false}
    );
    process.stdout.write(JSON.stringify({exitCode:result.exitCode,stdout:result.stdout}));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", program], {
    env: { ...process.env, MISSION_AGENT_HOME: agentHome },
    encoding: "utf8",
  });
  const result = JSON.parse(output);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).status, "fresh");
  assert.equal(await readFile(marker, "utf8"), "fresh");
});

test("Mission Agent state writes use atomic replacement", async () => {
  const source = await readFile(new URL("../public/mission-agent-0.6.7.mjs", import.meta.url), "utf8");
  assert.ok(source.includes("const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;"));
  assert.ok(source.includes("await rename(temporary, path);"));
});

test("concurrent heartbeat and terminal-ledger updates are serialized without lost fields", async () => {
  const agentHome = await mkdtemp(join(tmpdir(), "mission-agent-pb-state-queue-"));
  const moduleUrl = new URL("../public/mission-agent-0.6.7.mjs", import.meta.url).href;
  const program = `
    import { readFile } from "node:fs/promises";
    import { updateState } from ${JSON.stringify(moduleUrl)};
    await Promise.all([
      updateState({connected:true,lastHeartbeatAt:"heartbeat"}),
      updateState({projectBrainInFlight:{requestId:"request",result:{exitCode:0}}}),
      updateState({projectBrainReceipts:{"project-brain:operation":{centralAcknowledged:false}}}),
      updateState({stage:"project_brain_callback_retry"})
    ]);
    const state = JSON.parse(await readFile(${JSON.stringify(join(agentHome, "state.json"))},"utf8"));
    process.stdout.write(JSON.stringify({
      connected:state.connected,
      lastHeartbeatAt:state.lastHeartbeatAt,
      requestId:state.projectBrainInFlight.requestId,
      receipt:state.projectBrainReceipts["project-brain:operation"].centralAcknowledged,
      stage:state.stage
    }));
  `;
  const result = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", program], {
      env: { ...process.env, MISSION_AGENT_HOME: agentHome },
      encoding: "utf8",
    }),
  );
  assert.deepEqual(result, {
    connected: true,
    lastHeartbeatAt: "heartbeat",
    requestId: "request",
    receipt: false,
    stage: "project_brain_callback_retry",
  });
});

test("remote process timeout and output limits terminate the fixed executable", async () => {
  const { runProjectBrainProcess } = await import("../public/mission-agent-0.6.7.mjs");
  const timedOut = await runProjectBrainProcess(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    process.cwd(),
    20,
    10_000,
    { lost: false },
  );
  assert.equal(timedOut.timedOut, true);
  const exceeded = await runProjectBrainProcess(
    process.execPath,
    ["-e", "process.stdout.write('x'.repeat(20000))"],
    process.cwd(),
    5_000,
    100,
    { lost: false },
  );
  assert.equal(exceeded.exceeded, true);
});

test("exact context verification rejects stale HEAD, changed bytes, and reported-size mismatch", async () => {
  const { verifiedProjectBrainContext } = await import("../public/mission-agent-0.6.7.mjs");
  const bytes = Buffer.from("exact remote context");
  const assignment = {
    projectBrainContext: {
      startingSha: "a".repeat(40),
      verificationRequired: true,
      contentBase64: bytes.toString("base64"),
      checksum: createHash("sha256").update(bytes).digest("hex"),
      contractVersion: "1.0",
      contextBytes: bytes.byteLength,
    },
  };
  assert.equal(verifiedProjectBrainContext(assignment, "a".repeat(40)).content, bytes.toString());
  assert.throws(() => verifiedProjectBrainContext(assignment, "b".repeat(40)), /HEAD changed/);
  assert.throws(
    () =>
      verifiedProjectBrainContext(
        {
          projectBrainContext: {
            ...assignment.projectBrainContext,
            contentBase64: Buffer.from("changed").toString("base64"),
          },
        },
        "a".repeat(40),
      ),
    /checksum verification failed/,
  );
  assert.throws(
    () =>
      verifiedProjectBrainContext(
        {
          projectBrainContext: {
            ...assignment.projectBrainContext,
            contextBytes: bytes.byteLength + 1,
          },
        },
        "a".repeat(40),
      ),
    /checksum verification failed/,
  );
});

test("central result validation rejects malformed envelopes, changed response checksums, and stale repository binding", async () => {
  const { validateRemoteProjectBrainResultEnvelope } = await import("../application/remote-project-brain-results.ts");
  const request = {
    requestId: randomUUID(),
    idempotencyKey: `project-brain:${randomUUID()}`,
    operation: "detect_repository",
    requiredContractVersion: "1.0",
    requiredProjectBrainVersion: "0.4.0",
    requiredSchemaVersions: ["2.5.0"],
    startingSha: "a".repeat(40),
    repositoryLocator: `mission-agent://${"b".repeat(64)}`,
    timeoutMs: 15_000,
    artifactVersioning: false,
  };
  const assignment = {
    request,
    request_checksum: "c".repeat(64),
    repository_id: randomUUID(),
  };
  const envelope = {
    operation: request.operation,
    contract_version: "1.0",
    status: "succeeded",
    repository: {
      id: assignment.repository_id,
      checkout_path: request.repositoryLocator,
      head_sha: request.startingSha,
      ending_head_sha: request.startingSha,
    },
    artifacts: [],
    warnings: [],
    blockers: [],
    repository_files_changed: false,
    exit_classification: "success",
  };
  const unsigned = {
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    requestChecksum: assignment.request_checksum,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    startingSha: request.startingSha,
    endingSha: request.startingSha,
    projectBrainVersion: "0.4.0",
    schemaVersions: ["2.5.0"],
    durationMs: 1,
    process: { exitCode: 0, stdoutSha256: "d".repeat(64), stderrSha256: "e".repeat(64) },
    envelope,
  };
  const valid = { ...unsigned, responseChecksum: canonicalHash(unsigned) };
  assert.equal(validateRemoteProjectBrainResultEnvelope(valid, assignment).envelope.status, "succeeded");
  assert.throws(
    () => validateRemoteProjectBrainResultEnvelope({ ...valid, responseChecksum: "f".repeat(64) }, assignment),
    /checksum mismatch/,
  );
  assert.throws(
    () =>
      validateRemoteProjectBrainResultEnvelope(
        {
          ...valid,
          envelope: {
            ...envelope,
            repository: { ...envelope.repository, head_sha: "9".repeat(40) },
          },
        },
        assignment,
      ),
    /Invalid remote/,
  );
  assert.throws(
    () => validateRemoteProjectBrainResultEnvelope({ ...valid, envelope: { status: "succeeded" } }, assignment),
    /Invalid remote/,
  );
});

test("Mission Agent independently rejects invalid auth, registration, expiry, replay, policy, and approval binding", async () => {
  const { validateRemoteProjectBrainAuthoritySnapshot } = await import("../public/mission-agent-0.6.7.mjs");
  const secret = "remote-agent-secret";
  const repositoryId = randomUUID();
  const fingerprint = "a".repeat(64);
  const config = {
    workspaceId: randomUUID(),
    agentId: randomUUID(),
    secret,
    repositories: {
      [repositoryId]: {
        fingerprint,
        projectBrainWriteAllowed: true,
      },
    },
  };
  const sign = (value) => {
    const unsigned = { ...value };
    delete unsigned.requestChecksum;
    delete unsigned.missionControlSignature;
    const requestChecksum = canonicalHash(unsigned);
    return {
      ...unsigned,
      requestChecksum,
      missionControlSignature: createHmac("sha256", createHash("sha256").update(secret).digest("hex"))
        .update(requestChecksum)
        .digest("hex"),
    };
  };
  const base = {
    protocolVersion: "1.0",
    requestId: randomUUID(),
    operationId: randomUUID(),
    workspaceId: config.workspaceId,
    agentId: config.agentId,
    repositoryId,
    repositoryLocator: `mission-agent://${fingerprint}`,
    repositoryFingerprint: fingerprint,
    missionId: null,
    executionId: null,
    operation: "detect_repository",
    arguments: {},
    startingSha: "b".repeat(40),
    requiredProjectBrainVersion: "0.4.0",
    requiredContractVersion: "1.0",
    requiredSchemaVersions: ["2.5.0"],
    approvalId: null,
    approvalFingerprint: "c".repeat(64),
    policyDecision: { action: "project_brain.read", outcome: "allowed", reasons: [] },
    authorization: {
      allowedAgent: true,
      repositoryReadAllowed: true,
      repositoryWriteAllowed: false,
      repositoryCommitAllowed: false,
      requiredPermission: "read",
      resourcePermission: true,
      approvalRequired: false,
      approvalExpiresAt: null,
    },
    requestedArtifactTypes: [],
    timeoutMs: 15_000,
    maxOutputBytes: 1_000_000,
    artifactVersioning: false,
    requestedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    nonce: "n".repeat(24),
  };
  base.idempotencyKey = `project-brain:${base.operationId}`;
  const valid = sign(base);
  assert.equal(validateRemoteProjectBrainAuthoritySnapshot(config, valid).writing, false);
  assert.throws(
    () =>
      validateRemoteProjectBrainAuthoritySnapshot(config, {
        ...valid,
        missionControlSignature: "0".repeat(64),
      }),
    /signature is invalid/,
  );
  assert.throws(
    () =>
      validateRemoteProjectBrainAuthoritySnapshot(
        config,
        sign({ ...base, repositoryLocator: `mission-agent://${"f".repeat(64)}` }),
      ),
    /registration does not match/,
  );
  assert.throws(
    () =>
      validateRemoteProjectBrainAuthoritySnapshot(
        config,
        sign({
          ...base,
          requestedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    /expiry is invalid/,
  );
  assert.throws(
    () => validateRemoteProjectBrainAuthoritySnapshot(config, valid, { projectBrainNonces: [valid.nonce] }),
    /nonce was replayed/,
  );
  assert.throws(
    () =>
      validateRemoteProjectBrainAuthoritySnapshot(
        config,
        sign({
          ...base,
          policyDecision: { action: "project_brain.read", outcome: "denied", reasons: ["policy"] },
        }),
      ),
    /authorization snapshot is not permitted/,
  );
  const writeBase = {
    ...base,
    operation: "initialize_repository",
    arguments: { repository_id: repositoryId },
    requestedArtifactTypes: ["project_brain_initialization"],
    artifactVersioning: true,
    approvalId: randomUUID(),
    policyDecision: { action: "project_brain.repository_write", outcome: "allowed", reasons: [] },
    authorization: {
      ...base.authorization,
      repositoryWriteAllowed: true,
      repositoryCommitAllowed: true,
      requiredPermission: "write",
      approvalRequired: true,
      approvalExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  writeBase.idempotencyKey = `project-brain:${writeBase.operationId}`;
  const invalidFingerprint = sign(writeBase);
  assert.throws(
    () => validateRemoteProjectBrainAuthoritySnapshot(config, invalidFingerprint),
    /authorization snapshot is not permitted/,
  );
  const writeUnsigned = { ...writeBase };
  writeUnsigned.approvalFingerprint = canonicalHash({
    repositoryId,
    missionId: null,
    executionId: null,
    agentId: config.agentId,
    operation: "initialize_repository",
    arguments: writeBase.arguments,
    startingSha: writeBase.startingSha,
    locationMode: "mission_agent",
    expectedWriteScope: writeBase.requestedArtifactTypes,
    timeoutMs: writeBase.timeoutMs,
    maxOutputBytes: writeBase.maxOutputBytes,
    requiredProjectBrainVersion: "0.4.0",
    requiredContractVersion: "1.0",
    artifactVersioning: true,
  });
  const expiredApproval = sign({
    ...writeUnsigned,
    authorization: {
      ...writeUnsigned.authorization,
      approvalExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  assert.throws(() => validateRemoteProjectBrainAuthoritySnapshot(config, expiredApproval), /approval expired/);
});

test("dirty worktrees and invalid artifact paths, kinds, schemas, sizes, and checksums fail closed", async () => {
  const { verifiedPriorProjectBrainArtifacts, verifiedRemoteProjectBrainArtifact } =
    await import("../public/mission-agent-0.6.7.mjs");
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "mission-agent-pb-artifact-")));
  await writeFile(join(checkout, "dirty.txt"), "unverified");
  await assert.rejects(
    verifiedPriorProjectBrainArtifacts({}, checkout, "?? dirty.txt", randomUUID(), `mission-agent://${"a".repeat(64)}`),
    /clean or previously verified worktree/,
  );
  await mkdir(join(checkout, ".project-brain"), { recursive: true });
  const path = ".project-brain/context.yaml";
  const body = Buffer.from("schema_version: 2.5.0\n");
  await writeFile(join(checkout, path), body);
  const outside = join(await mkdtemp(join(tmpdir(), "mission-agent-pb-outside-")), "outside.yaml");
  await writeFile(outside, body);
  await symlink(outside, join(checkout, ".project-brain", "escape.yaml"));
  const descriptor = {
    kind: "context_pack",
    path,
    schema_version: "2.5.0",
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  assert.equal(
    (await verifiedRemoteProjectBrainArtifact(checkout, descriptor, ["context_pack"], ["2.5.0"], 0, 1_000)).totalBytes,
    body.byteLength,
  );
  for (const [changed, pattern] of [
    [{ ...descriptor, path: "../escape" }, /unsafe artifact path/],
    [{ ...descriptor, kind: "source_code" }, /kind outside/],
    [{ ...descriptor, schema_version: "9.0.0" }, /unsupported artifact schema/],
    [{ ...descriptor, sha256: "0".repeat(64) }, /integrity validation failed/],
  ])
    await assert.rejects(
      verifiedRemoteProjectBrainArtifact(checkout, changed, ["context_pack"], ["2.5.0"], 0, 1_000),
      pattern,
    );
  await assert.rejects(
    verifiedRemoteProjectBrainArtifact(checkout, descriptor, ["context_pack"], ["2.5.0"], 0, body.byteLength - 1),
    /integrity validation failed/,
  );
  await assert.rejects(
    verifiedRemoteProjectBrainArtifact(
      checkout,
      { ...descriptor, path: ".project-brain/escape.yaml" },
      ["context_pack"],
      ["2.5.0"],
      0,
      1_000,
    ),
    /escaped the checkout/,
  );
});

test("central execution handling rejects a different consumed checksum through the terminal mismatch path", async () => {
  const { enforceRemoteContextVerification } = await import("../application/remote-agent-messages.ts");
  const checksum = "a".repeat(64);
  let transitioned = false;
  await assert.rejects(
    enforceRemoteContextVerification(
      {
        context_checksum: checksum,
        starting_sha: "b".repeat(40),
        agent_verification_status: "not_reported",
      },
      {
        receivedContextChecksum: checksum,
        verifiedContextChecksum: "c".repeat(64),
        contextVerificationOutcome: "verified",
        startingSha: "b".repeat(40),
      },
      async () => {
        transitioned = true;
      },
    ),
    /context verification failed/,
  );
  assert.equal(transitioned, true);
  assert.deepEqual(
    await enforceRemoteContextVerification(
      {
        context_checksum: checksum,
        starting_sha: "b".repeat(40),
        agent_verification_status: "not_reported",
      },
      {
        receivedContextChecksum: checksum,
        verifiedContextChecksum: checksum,
        contextVerificationOutcome: "verified",
        startingSha: "b".repeat(40),
      },
      async () => assert.fail("matching evidence must not transition to failure"),
    ),
    {
      received: checksum,
      verified: checksum,
      outcome: "verified",
      startingSha: "b".repeat(40),
    },
  );
});

test("a lost successful-write callback retries the cached receipt with one subprocess and one A-to-B commit", async () => {
  const agentHome = await mkdtemp(join(tmpdir(), "mission-agent-pb-lost-callback-"));
  const checkout = await realpath(await mkdtemp(join(tmpdir(), "mission-agent-pb-lost-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: checkout });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: checkout });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: checkout });
  await writeFile(join(checkout, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd: checkout });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: checkout });
  const startSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  const fingerprint = createHash("sha256")
    .update(`local:${checkout}\n${checkout.split("/").at(-1)}`)
    .digest("hex");
  const executable = join(agentHome, "project-brain-fixture.mjs");
  const invocationMarker = join(agentHome, "consumer-invocations.txt");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
const args = process.argv.slice(2);
if (args[0] === "capabilities") {
  process.stdout.write(JSON.stringify({
    core_version:"0.4.0",
    consumer_contract_versions:["1.0"],
    supported_artifact_schema_versions:["2.5.0"],
    operations:{prepare_context:{}}
  }));
  process.exit(0);
}
appendFileSync(${JSON.stringify(invocationMarker)}, "run\\n");
const repo = args[args.indexOf("--repo") + 1];
const request = JSON.parse(args[args.indexOf("--request-json") + 1]);
const output = request.output;
const body = Buffer.from("schema_version: 2.5.0\\nartifact_type: context-pack\\n");
mkdirSync(dirname(join(repo, output)), {recursive:true});
writeFileSync(join(repo, output), body);
const head = execFileSync("git", ["rev-parse","HEAD"], {cwd:repo,encoding:"utf8"}).trim();
process.stdout.write(JSON.stringify({
  contract_version:"1.0",
  operation:"prepare_context",
  status:"succeeded",
  repository:{id:"fixture",checkout_path:repo,head_sha:head,ending_head_sha:head},
  artifacts:[{kind:"context_pack",path:output,sha256:createHash("sha256").update(body).digest("hex"),schema_version:"2.5.0"}],
  warnings:[],blockers:[],required_actions:[],human_approval_required:false,
  repository_files_changed:true,exit_classification:"success",data:{}
}));
`,
    { mode: 0o700 },
  );
  await chmod(executable, 0o700);
  const moduleUrl = new URL("../public/mission-agent-0.6.7.mjs", import.meta.url).href;
  const childProgram = `
    import { createHash, createHmac, randomUUID } from "node:crypto";
    import { writeFile } from "node:fs/promises";
    import { executeRemoteProjectBrain } from ${JSON.stringify(moduleUrl)};
    const canonical = (value) => {
      if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
      if (value && typeof value === "object") return "{" + Object.keys(value).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+":"+canonical(value[k])).join(",") + "}";
      return JSON.stringify(value);
    };
    const sha = value => createHash("sha256").update(value).digest("hex");
    const secret = "lost-callback-secret";
    const workspaceId = randomUUID(), agentId = randomUUID(), repositoryId = randomUUID(), operationId = randomUUID();
    const argumentsValue = {write:true,preview:false,objective:"fixture",role:"implementer",output:".project-brain/context.yaml"};
    const fingerprintInput = {
      repositoryId,missionId:null,executionId:null,agentId,operation:"prepare_context",arguments:argumentsValue,
      startingSha:${JSON.stringify(startSha)},locationMode:"mission_agent",expectedWriteScope:["project_brain_context_pack"],
      timeoutMs:5000,maxOutputBytes:100000,requiredProjectBrainVersion:"0.4.0",
      requiredContractVersion:"1.0",artifactVersioning:true
    };
    const approvalFingerprint = sha(canonical(fingerprintInput));
    const unsigned = {
      protocolVersion:"1.0",requestId:randomUUID(),operationId,workspaceId,agentId,repositoryId,
      repositoryLocator:"mission-agent://${fingerprint}",repositoryFingerprint:${JSON.stringify(fingerprint)},
      missionId:null,executionId:null,operation:"prepare_context",arguments:argumentsValue,
      startingSha:${JSON.stringify(startSha)},requiredProjectBrainVersion:"0.4.0",requiredContractVersion:"1.0",
      requiredSchemaVersions:["2.5.0"],approvalId:randomUUID(),approvalFingerprint,
      policyDecision:{action:"project_brain.repository_write",outcome:"allowed",reasons:[]},
      authorization:{allowedAgent:true,repositoryReadAllowed:true,repositoryWriteAllowed:true,repositoryCommitAllowed:true,
        requiredPermission:"write",resourcePermission:true,approvalRequired:true,approvalExpiresAt:new Date(Date.now()+60000).toISOString()},
      requestedArtifactTypes:["project_brain_context_pack"],timeoutMs:5000,maxOutputBytes:100000,artifactVersioning:true,
      requestedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),nonce:"n".repeat(24),
      idempotencyKey:"project-brain:"+operationId
    };
    const requestChecksum = sha(canonical(unsigned));
    const request = {...unsigned,requestChecksum,missionControlSignature:createHmac("sha256",sha(secret)).update(requestChecksum).digest("hex"),
      assignmentId:randomUUID(),leaseOwner:"fixture",leaseToken:"lease",leaseExpiresAt:new Date(Date.now()+60000).toISOString()};
    const config = {workspaceId,agentId,secret,projectBrainExecutable:${JSON.stringify(executable)},repositories:{
      [repositoryId]:{path:${JSON.stringify(checkout)},fingerprint:${JSON.stringify(fingerprint)},name:${JSON.stringify(
        checkout.split("/").at(-1),
      )},remoteUrl:undefined,branch:"main",commit:${JSON.stringify(startSha)},projectBrainWriteAllowed:true}
    }};
    await writeFile(${JSON.stringify(join(agentHome, "config.json"))}, JSON.stringify({...config,secretStorage:"file-0600"}), {mode:0o600});
    let terminalAttempts = 0;
    globalThis.fetch = async (url, options) => {
      const message = JSON.parse(options.body);
      if (String(url).endsWith("/reauthorize"))
        return new Response(JSON.stringify({authorized:true,requestFingerprint:approvalFingerprint}),{status:200});
      if (String(url).endsWith("/repositories"))
        return new Response(JSON.stringify({repository:{repository_id:repositoryId}}),{status:200});
      if (message.messageType === "RemoteProjectBrainOperationSucceeded") {
        terminalAttempts += 1;
        if (terminalAttempts === 1) throw new Error("simulated lost acknowledgement");
        return new Response(JSON.stringify({result:{status:"succeeded"}}),{status:200});
      }
      return new Response(JSON.stringify({result:{status:"running"}}),{status:200});
    };
    let firstFailed = false;
    try { await executeRemoteProjectBrain(config, request); } catch { firstFailed = true; }
    const reclaimed = {...request,leaseOwner:"fresh-runner",leaseToken:"fresh-lease",leaseExpiresAt:new Date(Date.now()+60000).toISOString()};
    await executeRemoteProjectBrain(config, reclaimed);
    process.stdout.write(JSON.stringify({firstFailed,terminalAttempts,reclaimedLease:reclaimed.leaseToken}));
  `;
  const childResult = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", childProgram], {
      env: { ...process.env, MISSION_AGENT_HOME: agentHome },
      encoding: "utf8",
    }),
  );
  assert.deepEqual(childResult, {
    firstFailed: true,
    terminalAttempts: 2,
    reclaimedLease: "fresh-lease",
  });
  assert.equal((await readFile(invocationMarker, "utf8")).trim().split("\n").length, 1);
  const endSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
  assert.notEqual(endSha, startSha);
  assert.equal(
    execFileSync("git", ["rev-list", "--count", `${startSha}..${endSha}`], {
      cwd: checkout,
      encoding: "utf8",
    }).trim(),
    "1",
  );
  assert.equal(execFileSync("git", ["rev-parse", `${endSha}^`], { cwd: checkout, encoding: "utf8" }).trim(), startSha);
});
