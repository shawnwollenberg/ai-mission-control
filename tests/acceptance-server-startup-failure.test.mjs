import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { bootstrapAcceptanceRun } from "../lib/acceptance-bootstrap-authority.ts";
import { acceptanceCleanupSucceeded, runAcceptanceCleanup } from "../scripts/cleanup-consensus-acceptance.ts";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const fileSha = async (path) => sha(await readFile(path));
const freePort = async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
};
const listenerAlive = (port) =>
  fetch(`http://127.0.0.1:${port}`)
    .then(() => true)
    .catch(() => false);

const bindings = Object.fromEntries(
  [
    "artifactSha256",
    "artifactMetadataSha256",
    "capabilityManifestSha256",
    "acceptanceSourceManifestSha256",
    "acceptanceContractSha256",
    "executableRegistrySha256",
    "disposableRegistrySha256",
    "providerRequirementsSha256",
    "providerProfilesSha256",
    "runtimeBindingsSha256",
    "modelAssignmentsSha256",
    "validatorRegistrySha256",
    "reviewChecklistSha256",
    "finalizerChecklistSha256",
    "reviewerImplementationSha256",
    "resourceInventoryImplementationSha256",
    "cleanupFinalizerSha256",
    "realAcceptanceHarnessSha256",
  ].map((key, index) => [key, String(index % 10).repeat(64)]),
);

async function executeFailureFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "mc-server-readiness-failure-"));
  const evidenceRoot = resolve(root, "evidence");
  const inventoryPath = resolve(evidenceRoot, "resource-inventory.json");
  const requestPath = resolve(root, "infrastructure-request.json");
  const fixturePath = resolve(root, "never-ready-server.mjs");
  const port = await freePort();
  const runId = randomUUID();
  await writeFile(
    fixturePath,
    `import{spawn}from'node:child_process';console.log('fixture startup');console.error('Authorization: Bearer fixture-'+String(42));const child=spawn(process.execPath,['-e',${JSON.stringify(
      `const http=require('http');http.createServer((q,r)=>{r.statusCode=503;r.end('not-ready')}).listen(${port},'127.0.0.1')`,
    )}],{stdio:'ignore',env:process.env});child.unref();setInterval(()=>{},1000);\n`,
  );
  const launcherPath = resolve("scripts/launch-consensus-acceptance-infrastructure.ts");
  const bootstrapPath = resolve("scripts/bootstrap-consensus-real-acceptance.ts");
  const request = {
    bootstrapInventoryPath: inventoryPath,
    resources: [
      {
        record: {
          resourceId: "mission-control-listener",
          type: "listener",
          identity: {
            host: "127.0.0.1",
            port,
            generation: "readiness-fixture",
            owningServerResourceId: "mission-control-server",
          },
          creatingStep: "test.listener",
          createdAt: new Date().toISOString(),
          cleanupPolicy: "stop",
          expectedTerminalState: "stopped",
        },
        creation: {
          kind: "command",
          executable: "/usr/bin/true",
          args: [],
          cwd: root,
          actualIdentity: { host: "127.0.0.1", port },
        },
      },
      {
        record: {
          resourceId: "mission-control-server",
          type: "mission_control_server",
          identity: { executable: process.execPath, generation: "readiness-fixture" },
          creatingStep: "test.server",
          createdAt: new Date().toISOString(),
          cleanupPolicy: "stop",
          expectedTerminalState: "stopped",
          dependsOn: ["mission-control-listener"],
        },
        creation: {
          kind: "process",
          executable: process.execPath,
          args: [fixturePath, "--token", "fixture-cli-secret"],
          cwd: root,
          readyUrl: `http://127.0.0.1:${port}/api/health`,
          readinessAttempts: 12,
          readinessDelayMs: 30,
        },
      },
    ],
  };
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  bootstrapAcceptanceRun({
    acceptanceRunId: runId,
    acceptanceRoot: root,
    evidenceRoot,
    inventoryPath,
    candidateBindings: bindings,
    launcherImplementationPath: bootstrapPath,
    expectedLauncherSha256: await fileSha(bootstrapPath),
    infrastructureLauncherPath: launcherPath,
    expectedInfrastructureLauncherSha256: await fileSha(launcherPath),
    infrastructureRequestSha256: await fileSha(requestPath),
    createdAt: new Date().toISOString(),
  });
  const child = spawn(process.execPath, ["--import", "tsx", launcherPath, requestPath], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));
  const exitCode = await new Promise((done) => child.once("close", done));
  assert.notEqual(exitCode, 0);
  assert.match(stderr, /did not become ready/);
  const harnessPath = `${inventoryPath}.infrastructure-failure-harness.json`;
  const harness = JSON.parse(await readFile(harnessPath, "utf8"));
  const resources = harness.runResourceInventory.resources;
  const server = resources.find((resource) => resource.resourceId === "mission-control-server");
  const listener = resources.find((resource) => resource.resourceId === "mission-control-listener");
  assert.equal(server.lifecycleState, "readiness_failed");
  assert.ok(server.identity.pid > 1);
  assert.equal(server.identity.pgid, server.identity.pid);
  assert.match(server.identity.processIdentitySha256, /^[a-f0-9]{64}$/);
  assert.ok(server.identity.identityVerifiedAt);
  assert.ok(server.identity.readinessPendingAt);
  assert.ok(listener.identity.owningPid > 1);
  assert.equal(listener.identity.serverGenerationId, "readiness-fixture");
  assert.match(listener.identity.ownershipEvidenceSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    resources.some((resource) =>
      ["mission_agent_process", "provider_subprocess", "disposable_repository", "worktree"].includes(resource.type),
    ),
    false,
  );
  const diagnostic = JSON.parse(await readFile(resolve(evidenceRoot, "server-startup-readiness-fixture.json"), "utf8"));
  assert.equal(diagnostic.readinessStatus, "readiness_failed");
  assert.equal(diagnostic.cleanup.processGroupSurviving, false);
  assert.equal(diagnostic.cleanup.listenerSurviving, false);
  assert.deepEqual(diagnostic.cleanup.survivingPids, []);
  assert.equal(/bearer\s+(?!\[REDACTED\])/i.test(JSON.stringify(diagnostic)), false);
  assert.match(diagnostic.stdoutExcerpt, /fixture startup/);
  assert.match(diagnostic.stderrExcerpt, /Authorization: \[REDACTED\]/);
  assert.equal(diagnostic.stderrExcerpt.includes("fixture-42"), false);
  assert.equal(diagnostic.startupArgumentsJson.includes("fixture-cli-secret"), false);
  assert.equal(diagnostic.secretScan.passed, true);
  assert.equal(await listenerAlive(port), false);
  const cleanupPath = resolve(evidenceRoot, "cleanup.json");
  await runAcceptanceCleanup(harnessPath, cleanupPath, {
    assertSafety: () => ({ acceptanceRoot: root, evidence: {} }),
  });
  const cleanup = JSON.parse(await readFile(cleanupPath, "utf8"));
  assert.equal(cleanup.allRunResourcesAccounted, true);
  assert.equal(cleanup.cleanupSucceeded, true);
  assert.equal(
    cleanup.resourceInventory.outcomes.some((outcome) => outcome.observation.surviving === true),
    false,
  );
  const retryPath = resolve(evidenceRoot, "cleanup-retry.json");
  await runAcceptanceCleanup(harnessPath, retryPath, {
    assertSafety: () => ({ acceptanceRoot: root, evidence: {} }),
  });
  const retry = JSON.parse(await readFile(retryPath, "utf8"));
  assert.equal(retry.cleanupSucceeded, true);
  assert.equal(await listenerAlive(port), false);
  return { root, port };
}

test("accounting is distinct from successful cleanup", () => {
  const resources = [{ resourceId: "listener", expectedTerminalState: "stopped" }];
  assert.equal(
    acceptanceCleanupSucceeded(resources, [
      { resourceId: "listener", state: "cleanup_failed", observation: { surviving: true } },
    ]),
    false,
  );
  assert.equal(
    acceptanceCleanupSucceeded(resources, [
      { resourceId: "listener", state: "stopped", observation: { surviving: true } },
    ]),
    false,
  );
  assert.equal(
    acceptanceCleanupSucceeded(resources, [
      {
        resourceId: "listener",
        state: "stopped",
        observation: {
          surviving: false,
          observedTerminalState: "stopped",
          resourceTerminallyVerified: true,
          resourceTerminallyVerifiedAt: new Date().toISOString(),
        },
      },
    ]),
    true,
  );
  assert.equal(acceptanceCleanupSucceeded(resources, [{ resourceId: "listener", state: "stopped" }]), false);
});

test("readiness failure governs and automatically reconciles parent, child listener, and diagnostics repeatedly", async () => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fixture = await executeFailureFixture();
    try {
      assert.equal(await listenerAlive(fixture.port), false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});
