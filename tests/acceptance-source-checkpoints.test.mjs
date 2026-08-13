import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash } from "../lib/canonical-json.ts";
import {
  ACCEPTANCE_SOURCE_CLOSURE_FAILURE,
  AcceptanceSourceCheckpointController,
  acceptanceSourceCheckpoints,
  loadApprovedAcceptanceSource,
  finalAcceptanceSourceCheckpoints,
  revalidateFinalAcceptanceSource,
} from "../lib/acceptance-source-checkpoints.ts";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const id = "00000000-0000-4000-8000-000000000001";
const binding = (checkpoint) =>
  ({
    before_mission_creation: { action: "create_consensus_mission", command_id: id, mission_id: id, repository_id: id },
    before_human_approval: {
      action: "submit_human_approval",
      approval_id: id,
      canonical_plan_hash: "a".repeat(64),
      mission_id: id,
    },
    before_child_creation: {
      action: "create_child_implementation_mission",
      canonical_plan_hash: "a".repeat(64),
      child_mission_id: id,
      command_id: id,
      parent_mission_id: id,
    },
    before_executor_claim: {
      action: "authorize_executor_claim",
      assignment_id: id,
      child_mission_id: id,
      execution_id: id,
      executor_agent_id: id,
      parent_mission_id: id,
    },
  })[checkpoint];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "source-checkpoint-"));
  await mkdir(join(root, "domain"));
  await mkdir(join(root, "application"));
  const source = join(root, "application", "authority.ts");
  const schema = join(root, "domain", "mission-control-acceptance-source-manifest.schema.json");
  const manifestPath = join(root, "domain", "mission-control-acceptance-source-manifest.json");
  await writeFile(source, "export const authority = 'bounded';\n");
  await writeFile(schema, "{}\n");
  const manifest = {
    schemaVersion: "mission-control-acceptance-source-manifest/1",
    scope: "disposable_consensus_acceptance_security_boundary",
    sourceBase: "a".repeat(40),
    includedRoots: ["application", "domain"],
    includedFiles: [],
    excludedFiles: ["domain/mission-control-acceptance-source-manifest.json"],
    files: {
      "application/authority.ts": hash(await readFile(source)),
      "domain/mission-control-acceptance-source-manifest.schema.json": hash(await readFile(schema)),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const artifact = {
    sourceCommit: manifest.sourceBase,
    acceptanceSourceManifestSha256: hash(await readFile(manifestPath)),
    acceptanceSourceManifestCanonicalSha256: canonicalHash(manifest),
    acceptanceSourceManifestSchemaSha256: hash(await readFile(schema)),
  };
  return { root, source, manifestPath, artifact };
}

test("unchanged source is freshly validated at all four ordered checkpoints", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const evidence = [];
  const controller = new AcceptanceSourceCheckpointController(
    loadApprovedAcceptanceSource(value.artifact, value.root),
    "run-positive",
    (item) => evidence.push(item),
  );
  let actions = 0;
  for (const checkpoint of acceptanceSourceCheckpoints)
    controller.run(checkpoint, binding(checkpoint), (bindingHash) => {
      assert.match(bindingHash, /^[a-f0-9]{64}$/);
      actions += 1;
    });
  assert.equal(actions, 4);
  assert.deepEqual(
    evidence.map((item) => item.result),
    ["pass", "pass", "pass", "pass"],
  );
  assert.equal(new Set(evidence.map((item) => item.checkpoint_id)).size, 4);
  assert.equal(new Set(evidence.map((item) => item.binding_hash)).size, 4);
});

test("final review and cleanup checkpoints re-enumerate the full source closure and bind the exact run", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const approved = loadApprovedAcceptanceSource(value.artifact, value.root);
  const candidateBinding = {
    artifact_sha256: "1".repeat(64),
    acceptance_contract_sha256: "2".repeat(64),
    executable_registry_sha256: "3".repeat(64),
    source_manifest_sha256: value.artifact.acceptanceSourceManifestCanonicalSha256,
  };
  for (const checkpoint of finalAcceptanceSourceCheckpoints) {
    const evidence = revalidateFinalAcceptanceSource({
      approved,
      checkpoint,
      acceptanceRunId: "run-final",
      candidateBinding,
    });
    assert.equal(evidence.result, "pass");
    assert.equal(evidence.acceptance_run_id, "run-final");
    assert.equal(evidence.checkpoint, checkpoint);
  }
  await writeFile(value.source, "export const authority = 'changed-during-review';\n");
  assert.throws(
    () =>
      revalidateFinalAcceptanceSource({
        approved,
        checkpoint: "before_final_cleanup",
        acceptanceRunId: "run-final",
        candidateBinding,
      }),
    /ACCEPTANCE SOURCE CLOSURE FAILURE/,
  );
});

const mutations = {
  modified: async (value) => writeFile(value.source, "export const authority = 'changed';\n"),
  deleted: async (value) => unlink(value.source),
  added: async (value) => writeFile(join(value.root, "application", "added.ts"), "export {};\n"),
  changed_manifest: async (value) => writeFile(value.manifestPath, "{}\n"),
  changed_manifest_hash: async (value) => {
    value.artifact.acceptanceSourceManifestSha256 = "f".repeat(64);
  },
  symlink_substitution: async (value) => {
    await unlink(value.source);
    await symlink(value.manifestPath, value.source);
  },
  file_type_substitution: async (value) => {
    await unlink(value.source);
    await mkdir(value.source);
  },
};

for (const checkpoint of acceptanceSourceCheckpoints) {
  for (const [mutation, mutate] of Object.entries(mutations)) {
    test(`${checkpoint} rejects ${mutation} and does not invoke its protected action`, async (t) => {
      const value = await fixture();
      t.after(() => rm(value.root, { recursive: true, force: true }));
      const evidence = [];
      const controller = new AcceptanceSourceCheckpointController(
        loadApprovedAcceptanceSource(value.artifact, value.root),
        `run-${checkpoint}-${mutation}`,
        (item) => evidence.push(item),
      );
      const target = acceptanceSourceCheckpoints.indexOf(checkpoint);
      for (let index = 0; index < target; index += 1)
        controller.run(
          acceptanceSourceCheckpoints[index],
          binding(acceptanceSourceCheckpoints[index]),
          () => undefined,
        );
      await mutate(value);
      let actions = 0;
      assert.throws(
        () => controller.run(checkpoint, binding(checkpoint), () => (actions += 1)),
        new RegExp(ACCEPTANCE_SOURCE_CLOSURE_FAILURE),
      );
      assert.equal(actions, 0);
      assert.equal(evidence.at(-1).result, "fail");
    });
  }
}

for (const checkpoint of acceptanceSourceCheckpoints) {
  test(`${checkpoint} rejects wrong, missing, and extra protected-action identity`, async (t) => {
    const value = await fixture();
    t.after(() => rm(value.root, { recursive: true, force: true }));
    const make = () => {
      const controller = new AcceptanceSourceCheckpointController(
        loadApprovedAcceptanceSource(value.artifact, value.root),
        "run-action",
        () => undefined,
      );
      const target = acceptanceSourceCheckpoints.indexOf(checkpoint);
      for (let index = 0; index < target; index += 1)
        controller.run(
          acceptanceSourceCheckpoints[index],
          binding(acceptanceSourceCheckpoints[index]),
          () => undefined,
        );
      return controller;
    };
    assert.throws(
      () => make().run(checkpoint, { ...binding(checkpoint), action: "wrong_action" }, () => undefined),
      /binding is invalid/,
    );
    const { action: ignored, ...missing } = binding(checkpoint);
    assert.ok(ignored);
    assert.throws(() => make().run(checkpoint, missing, () => undefined), /binding is invalid/);
    assert.throws(
      () => make().run(checkpoint, { ...binding(checkpoint), extra_id: id }, () => undefined),
      /binding is invalid/,
    );
  });

  test(`${checkpoint} receipts reject wrong run, wrong phase, and reuse`, async (t) => {
    const value = await fixture();
    t.after(() => rm(value.root, { recursive: true, force: true }));
    let receipt;
    const controller = new AcceptanceSourceCheckpointController(
      loadApprovedAcceptanceSource(value.artifact, value.root),
      "run-identity",
      (item) => (receipt = item),
    );
    const target = acceptanceSourceCheckpoints.indexOf(checkpoint);
    for (let index = 0; index <= target; index += 1)
      controller.run(acceptanceSourceCheckpoints[index], binding(acceptanceSourceCheckpoints[index]), () => undefined);
    assert.throws(() => controller.consume(receipt, checkpoint, "run-other"), /binding rejected/);
    const wrongPhase = checkpoint === "before_mission_creation" ? "before_human_approval" : "before_mission_creation";
    assert.throws(() => controller.consume(receipt, wrongPhase, "run-identity"), /binding rejected/);
    assert.throws(() => controller.consume(receipt, checkpoint, "run-identity"), /binding rejected/);
    assert.throws(
      () =>
        controller.consume(
          { ...receipt, checkpoint_id: `forged-${receipt.checkpoint_id}` },
          checkpoint,
          "run-identity",
        ),
      /binding rejected/,
    );
  });
}
