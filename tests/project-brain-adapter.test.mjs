import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectBrainAdapterError, ProjectBrainClient } from "../integrations/project-brain/client.ts";
import { ProjectBrainService } from "../integrations/project-brain/service.ts";
import { approvalInbox, contextEvidence, projectStatus } from "../integrations/project-brain/projections.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectBrainPanel } from "../integrations/project-brain/project-brain-panel.tsx";

async function fixture(body) {
  const root = await mkdtemp(path.join(tmpdir(), "mission-control-project-brain-"));
  const executable = path.join(root, "project-brain");
  await writeFile(executable, `#!/bin/sh\n${body}\n`);
  await chmod(executable, 0o755);
  return { root, executable };
}

const okEnvelope = JSON.stringify({
  contract_version: "1.0",
  operation: "get_summary",
  status: "succeeded",
  repository: { path: "/fixture", git_sha: "abc123" },
  artifacts: [{ path: ".project-brain/context/example.json" }],
  warnings: [],
  blockers: [],
  required_actions: [],
  human_approval_required: false,
  repository_files_changed: false,
  exit_classification: "success",
  data: { title: "<script>not html</script>" },
});

test("capability negotiation accepts consumer contract 1.0", async () => {
  const fx = await fixture(
    `printf '%s' '{"consumer_contract_versions":["1.0"],"current_consumer_contract_version":"1.0","supported_artifact_schema_versions":["2.5.0"],"adapter_compatibility":{"compatible":true,"skill_adapter_version":"0.4.0"},"operations":{}}'`,
  );
  const value = await new ProjectBrainClient({ executable: fx.executable }).capabilities(fx.root);
  assert.equal(value.current_consumer_contract_version, "1.0");
});

test("missing executable is a typed not-installed failure", async () => {
  const fx = await fixture("exit 0");
  const client = new ProjectBrainClient({ executable: path.join(fx.root, "missing") });
  await assert.rejects(() => client.capabilities(fx.root), (error) => {
    assert.equal(error.classification, "not_installed");
    return true;
  });
});

test("malformed output and contract mismatch are rejected", async () => {
  const malformed = await fixture(`printf 'not-json'`);
  await assert.rejects(
    () => new ProjectBrainClient({ executable: malformed.executable }).capabilities(malformed.root),
    (error) => error instanceof ProjectBrainAdapterError && error.classification === "invalid_response",
  );
  const incompatible = await fixture(`printf '%s' '{"consumer_contract_versions":["2.0"]}'`);
  await assert.rejects(
    () => new ProjectBrainClient({ executable: incompatible.executable }).capabilities(incompatible.root),
    (error) => error instanceof ProjectBrainAdapterError && error.classification === "incompatible_contract",
  );
});

test("timeouts and output bounds fail closed", async () => {
  const slow = await fixture("sleep 1");
  await assert.rejects(
    () => new ProjectBrainClient({ executable: slow.executable, timeoutMs: 10 }).capabilities(slow.root),
    (error) => error instanceof ProjectBrainAdapterError && error.classification === "timeout",
  );
  const noisy = await fixture(`printf '%0200d' 1`);
  await assert.rejects(
    () => new ProjectBrainClient({ executable: noisy.executable, maxOutputBytes: 20 }).capabilities(noisy.root),
    (error) => error instanceof ProjectBrainAdapterError && error.classification === "output_limit",
  );
});

test("successful calls return evidence-safe audit events", async () => {
  const fx = await fixture(`printf '%s' '${okEnvelope}'`);
  const result = await new ProjectBrainClient({ executable: fx.executable }).execute({
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    repositoryPath: fx.root,
    missionId: "mission-1",
    executionId: "execution-1",
    operation: "get_summary",
    request: { secret: "must-not-enter-audit" },
  });
  assert.equal(result.auditEvent.operation, "get_summary");
  assert.deepEqual(result.auditEvent.artifactReferences, [".project-brain/context/example.json"]);
  assert.deepEqual(result.auditEvent.argumentKeys, ["secret"]);
  assert.equal(result.auditEvent.stdoutSha256.length, 64);
  assert.doesNotMatch(JSON.stringify(result.auditEvent), /must-not-enter-audit|script/);
});

test("context preview is explicit and binding carries mission identity", async () => {
  const fx = await fixture(`printf '%s' '${okEnvelope}'`);
  const service = new ProjectBrainService(new ProjectBrainClient({ executable: fx.executable }));
  const scope = {
    workspaceId: "workspace-1",
    repositoryId: "repository-1",
    repositoryPath: fx.root,
    missionId: "mission-1",
    executionId: "execution-1",
  };
  assert.equal((await service.previewContext(scope, { budget_bytes: 12000 })).auditEvent.operation, "prepare_context");
  assert.equal((await service.prepareAndBindContext(scope, { task: "fix" })).auditEvent.executionId, "execution-1");
});

test("status projection distinguishes repository and compatibility failures", () => {
  const capabilities = {
    consumer_contract_versions: ["1.0"],
    current_consumer_contract_version: "1.0",
    supported_artifact_schema_versions: ["2.5.0"],
    adapter_compatibility: { compatible: true, skill_adapter_version: "0.4.0" },
    operations: {},
  };
  assert.equal(projectStatus({ unavailable: true }), "diagnostics_unavailable");
  assert.equal(projectStatus({}), "incompatible");
  assert.equal(
    projectStatus({
      capabilities,
      detection: { ...JSON.parse(okEnvelope), exit_classification: "not_initialized" },
    }),
    "not_initialized",
  );
  assert.equal(
    projectStatus({
      capabilities,
      detection: JSON.parse(okEnvelope),
      validation: { ...JSON.parse(okEnvelope), status: "failed" },
    }),
    "invalid",
  );
});

test("context evidence fails closed on HEAD mismatch and produces a timeline item", () => {
  const value = JSON.parse(okEnvelope);
  value.data = {
    context_pack: {
      consumer_binding: { mission_id: "mission-1", execution_id: "execution-1", starting_sha: "old" },
    },
  };
  value.artifacts[0].sha256 = "a".repeat(64);
  value.artifacts[0].schema_version = "2.5.0";
  const projected = contextEvidence(value, {
    missionId: "mission-1",
    executionId: "execution-1",
    startingSha: "new",
  });
  assert.equal(projected.valid, false);
  assert.deepEqual(projected.mismatches, ["starting_sha"]);
  assert.equal(projected.timelineItem.kind, "project_brain_context");
});

test("approval projection remains read-only and rendered repository text is escaped", () => {
  const knowledge = {
    ...JSON.parse(okEnvelope),
    data: { knowledge: { proposed: [{ claim: "<script>alert(1)</script>" }] } },
  };
  const curation = { ...JSON.parse(okEnvelope), data: { reviews: [{ review: { disposition: "review" } }] } };
  const inbox = approvalInbox(knowledge, curation);
  assert.equal(inbox.promotionAvailable, false);
  const html = renderToStaticMarkup(ProjectBrainPanel({ summary: knowledge }));
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
