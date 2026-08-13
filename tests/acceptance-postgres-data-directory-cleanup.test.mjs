import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { AcceptanceResourceInventory } from "../lib/acceptance-resource-inventory.ts";
import { createGovernedAcceptanceResource } from "../lib/acceptance-resource-creator.ts";
import { governedPostgresDataDirectory } from "../lib/acceptance-postgres-data-directory.ts";
import { runAcceptanceCleanup } from "../scripts/cleanup-consensus-acceptance.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const bindings = Object.freeze({
  artifactSha256: "1".repeat(64),
  artifactMetadataSha256: "2".repeat(64),
  capabilityManifestSha256: "3".repeat(64),
  acceptanceSourceManifestSha256: "4".repeat(64),
  acceptanceContractSha256: "5".repeat(64),
  executableRegistrySha256: "6".repeat(64),
  disposableRegistrySha256: "7".repeat(64),
  providerRequirementsSha256: "8".repeat(64),
  providerProfilesSha256: "9".repeat(64),
  runtimeBindingsSha256: "a".repeat(64),
  modelAssignmentsSha256: "b".repeat(64),
  validatorRegistrySha256: "c".repeat(64),
  reviewChecklistSha256: "d".repeat(64),
  finalizerChecklistSha256: "e".repeat(64),
  reviewerImplementationSha256: "f".repeat(64),
  resourceInventoryImplementationSha256: "0".repeat(64),
  cleanupFinalizerSha256: "1".repeat(64),
  realAcceptanceHarnessSha256: "a".repeat(64),
});
const processIdentity = (pid) =>
  hash(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=", "-o", "pid="], { encoding: "utf8" }).trim());
const exists = (path) =>
  stat(path)
    .then(() => true)
    .catch(() => false);
const freePort = async () => {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
};

async function fixture({ serviceState = "created", outsidePath, withServer = false, precreate = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "mc-postgres-directory-cleanup-"));
  const data = outsidePath ?? resolve(root, "postgres-data");
  if (precreate) {
    await mkdir(data, { recursive: false });
    await writeFile(resolve(data, "partial-or-complete-cluster"), "bounded fixture\n");
  }
  const port = await freePort();
  let child;
  if (withServer) {
    child = spawn(process.execPath, ["-e", `require('net').createServer().listen(${port},'127.0.0.1')`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    await new Promise((done) => setTimeout(done, 100));
  }
  const runId = randomUUID();
  const inventory = new AcceptanceResourceInventory(
    runId,
    bindings,
    bindings.realAcceptanceHarnessSha256,
    new Date().toISOString(),
  );
  inventory.register({
    resourceId: "postgres-data-directory",
    type: "postgres_data_directory",
    identity: {
      path: data,
      intendedPath: data,
      acceptanceRunId: runId,
      candidateArtifactSha256: bindings.artifactSha256,
      databaseServiceResourceId: "database-service",
      host: "127.0.0.1",
      port,
      ownershipToken: randomUUID(),
    },
    creatingStep: "test.reserve_directory",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
    lifecycleState: "created",
  });
  const service = {
    resourceId: "database-service",
    type: "database_process",
    identity: {
      dataDirectory: data,
      ownershipToken: randomUUID(),
      ...(child
        ? { pid: child.pid, pgid: child.pid, processIdentitySha256: processIdentity(child.pid) }
        : { pid: 999999, pgid: 999999, processIdentitySha256: "f".repeat(64) }),
    },
    creatingStep: "test.start_database",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "stop",
    expectedTerminalState: serviceState === "creation_failed" ? "creation_failed" : "stopped",
    lifecycleState: serviceState,
    dependsOn: ["postgres-data-directory"],
    ...(serviceState === "creation_failed" ? { creationFailure: "initdb failed" } : {}),
  };
  inventory.register(service);
  const snapshot = inventory.journalSnapshot();
  const harness = resolve(root, "harness.json");
  await writeFile(
    harness,
    JSON.stringify({
      workspaceId: runId,
      candidateBindings: snapshot.candidateBindings,
      evidenceIndex: { sha256: "e".repeat(64) },
      runResourceInventory: snapshot,
    }),
  );
  return { root, data, child, harness, runId };
}

async function cleanup(f, suffix = "cleanup") {
  const output = resolve(f.root, `${suffix}.json`);
  await runAcceptanceCleanup(f.harness, output, { assertSafety: () => ({ acceptanceRoot: f.root, evidence: {} }) });
  return JSON.parse(await readFile(output, "utf8"));
}

async function creationCrashFixture(precreate) {
  const root = await mkdtemp(resolve(tmpdir(), "mc-postgres-creation-crash-"));
  const data = resolve(root, "postgres-data");
  if (precreate) await mkdir(data);
  const runId = randomUUID();
  const inventory = new AcceptanceResourceInventory(
    runId,
    bindings,
    bindings.realAcceptanceHarnessSha256,
    new Date().toISOString(),
  );
  inventory.reserve({
    resourceId: "postgres-data-directory",
    type: "postgres_data_directory",
    identity: {
      intendedPath: data,
      acceptanceRunId: runId,
      candidateArtifactSha256: bindings.artifactSha256,
      databaseServiceResourceId: "database-service",
      host: "127.0.0.1",
      port: await freePort(),
      ownershipToken: randomUUID(),
    },
    creatingStep: "test.crash_window",
    createdAt: new Date().toISOString(),
    cleanupPolicy: "delete",
    expectedTerminalState: "deleted",
    lifecycleState: "creation_reserved",
    reservationIdentity: "e".repeat(64),
    reservedAt: new Date().toISOString(),
  });
  const snapshot = inventory.journalSnapshot();
  const harness = resolve(root, "harness.json");
  await writeFile(
    harness,
    JSON.stringify({
      workspaceId: runId,
      candidateBindings: snapshot.candidateBindings,
      evidenceIndex: { sha256: "e".repeat(64) },
      runResourceInventory: snapshot,
    }),
  );
  return { root, data, harness };
}

test("normal PostgreSQL service stop precedes governed data-directory deletion", async () => {
  const f = await fixture({ withServer: true });
  try {
    const report = await cleanup(f);
    assert.equal(report.resourceInventory.outcomes.find((x) => x.resourceId === "database-service").state, "stopped");
    assert.equal(
      report.resourceInventory.outcomes.find((x) => x.resourceId === "postgres-data-directory").state,
      "deleted",
    );
    assert.equal(await exists(f.data), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("directory creation occurs only after its durable governed reservation", async () => {
  const root = await mkdtemp("/tmp/mc-postgres-reservation-");
  const data = resolve(root, "postgres-data");
  const inventory = new AcceptanceResourceInventory(
    randomUUID(),
    bindings,
    bindings.realAcceptanceHarnessSha256,
    new Date().toISOString(),
  );
  const persistedStates = [];
  try {
    await createGovernedAcceptanceResource({
      inventory,
      record: {
        resourceId: "postgres-data-directory",
        type: "postgres_data_directory",
        identity: { intendedPath: data },
        creatingStep: "test.reserve",
        createdAt: new Date().toISOString(),
        cleanupPolicy: "delete",
        expectedTerminalState: "deleted",
      },
      persist: () => persistedStates.push(inventory.resourceRecords()[0].lifecycleState),
      create: async () => {
        assert.equal(await exists(data), false);
        await mkdir(data);
        return data;
      },
      observeIdentity: (path) => ({ path }),
      emergencyCleanup: (path) => rm(path, { recursive: true, force: true }),
    });
    assert.deepEqual(persistedStates, ["creation_reserved", "created"]);
    assert.equal(governedPostgresDataDirectory(data, root), resolve(await realpath(root), "postgres-data"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [name, precreate] of [
  ["before mkdir", false],
  ["after mkdir but before created persistence", true],
])
  test(`creation crash ${name} is normalized and leaves no data directory across retry`, async () => {
    const f = await creationCrashFixture(precreate);
    try {
      const first = await cleanup(f, "first");
      assert.equal(first.resourceInventory.outcomes[0].state, "creation_failed");
      assert.equal(await exists(f.data), false);
      if (precreate) await mkdir(f.data);
      const retry = await cleanup(f, "retry");
      assert.equal(retry.resourceInventory.outcomes[0].state, "creation_failed");
      assert.equal(await exists(f.data), false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

for (const [name, state] of [
  ["failed initdb", "creation_failed"],
  ["server startup failure", "creation_failed"],
  ["server crash", "created"],
])
  test(`${name} leaves no governed PostgreSQL data directory`, async () => {
    const f = await fixture({ serviceState: state });
    try {
      const report = await cleanup(f);
      assert.equal(report.resourceInventory.outcomes.at(-1).state, "deleted");
      assert.equal(await exists(f.data), false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

test("cleanup retry re-probes a recreated directory after process stop and partial deletion", async () => {
  const f = await fixture();
  try {
    await cleanup(f, "first");
    await mkdir(f.data);
    await writeFile(resolve(f.data, "partial"), "partial\n");
    const report = await cleanup(f, "retry");
    assert.equal(
      report.resourceInventory.outcomes.find((x) => x.resourceId === "postgres-data-directory").state,
      "deleted",
    );
    assert.equal(await exists(f.data), false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("already-deleted PostgreSQL directory is an idempotent successful cleanup", async () => {
  const f = await fixture({ precreate: false });
  try {
    const report = await cleanup(f);
    assert.equal(report.resourceInventory.outcomes.at(-1).state, "deleted");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

for (const [name, path] of [
  ["acceptance root", (root) => root],
  ["unrelated PostgreSQL path", () => "/usr/local/var/postgresql@17"],
  ["system PostgreSQL path", () => "/Library/PostgreSQL/15/data"],
])
  test(`PostgreSQL data-directory cleanup rejects ${name}`, async () => {
    const base = await mkdtemp(resolve(tmpdir(), "mc-postgres-rejection-"));
    const target = path(base);
    const f = await fixture({ outsidePath: target, precreate: false });
    try {
      const report = await cleanup(f);
      const outcome = report.resourceInventory.outcomes.find((x) => x.resourceId === "postgres-data-directory");
      assert.equal(outcome.state, "cleanup_failed");
      assert.match(outcome.observation.error, /escapes acceptance root/);
    } finally {
      await rm(f.root, { recursive: true, force: true });
      if (base !== f.root) await rm(base, { recursive: true, force: true });
    }
  });

test("an in-root symlink to an external PostgreSQL directory is never traversed", async () => {
  const external = await mkdtemp(resolve(tmpdir(), "mc-external-postgres-"));
  const marker = resolve(external, "must-survive");
  await writeFile(marker, "external\n");
  const f = await fixture({ precreate: false });
  await symlink(external, f.data);
  try {
    const report = await cleanup(f);
    assert.equal(
      report.resourceInventory.outcomes.find((x) => x.resourceId === "postgres-data-directory").state,
      "cleanup_failed",
    );
    assert.equal(await exists(marker), true);
  } finally {
    await rm(f.root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("two sequential disposable runs reconcile zero PostgreSQL directories", async () => {
  for (let index = 0; index < 2; index += 1) {
    const f = await fixture();
    try {
      await cleanup(f);
      assert.equal(await exists(f.data), false);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});
