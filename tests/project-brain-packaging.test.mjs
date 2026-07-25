import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectBrainCommit = "09cae9482712decc20f043aecb38d944beacfe20";
const sourceChecksum = "1d127947f5a0ca5497d4a06c1497e36e00057d0551839ac2855b798c275c0d26";
const missionAgentChecksum = "00385c38db1f524ad428095f71d9bbc8eaa4f538c66cc1954bba79fe7981803e";

test("dedicated worker image pins Project Brain and keeps runtime installation offline", async () => {
  const worker = await readFile("Dockerfile.project-brain-worker", "utf8");
  const web = await readFile("Dockerfile", "utf8");
  assert.match(worker, new RegExp(projectBrainCommit));
  assert.match(worker, new RegExp(sourceChecksum));
  assert.match(worker, /sha256sum --check/);
  assert.match(worker, /project_brain-0\.4\.0-py3-none-any\.whl/);
  assert.match(worker, /pip install --no-cache-dir/);
  assert.match(worker, /--require-hashes/);
  assert.match(worker, /snapshot\.debian\.org/);
  assert.match(worker, /USER mission-control/);
  assert.match(worker, /HEALTHCHECK/);
  assert.doesNotMatch(worker.split(/^FROM .* AS runner$/m)[1], /github\\.com/);
  assert.doesNotMatch(web, /python3|project-brain/i);
});

test("supported topology gives Project Brain a private worker and unsupported Render stays fail-closed", async () => {
  const [stack, compose, render] = await Promise.all([
    readFile("infra/mission-control-stack.ts", "utf8"),
    readFile("compose.yml", "utf8"),
    readFile("render.yaml", "utf8"),
  ]);
  for (const topology of [stack, compose]) {
    assert.match(topology, /project-brain-worker/);
    assert.match(topology, /PROJECT_BRAIN_EXECUTABLE/);
    assert.match(topology, /PROJECT_BRAIN_REQUIRED_VERSION/);
    assert.match(topology, /PROJECT_BRAIN_CONTRACT_VERSION/);
    assert.match(topology, /PROJECT_BRAIN_TIMEOUT_MS/);
    assert.match(topology, /PROJECT_BRAIN_MAX_OUTPUT_BYTES/);
    assert.doesNotMatch(topology, /docker\.sock/);
  }
  assert.doesNotMatch(render, /mission-control-project-brain-worker/);
  assert.match(render, /PROJECT_BRAIN_EXECUTION_MODE, value: disabled/);
  assert.match(stack, /mission-control-generic-worker/);
  assert.match(stack, /scripts\/worker\.ts/);
  assert.match(stack, /PROJECT_BRAIN_LOCAL_EXECUTION=disabled/);
  assert.match(compose, /PROJECT_BRAIN_LOCAL_EXECUTION: enabled/);
  assert.match(stack, /@\$\{props\.projectBrainImageDigest\}/);
  assert.doesNotMatch(compose.match(/project-brain-worker:[\s\S]*?postgres:/)?.[0] ?? "", /ports:/);
});

test("packaging repair preserves contracts, migrations, and Mission Agent checksum", async () => {
  const [manifest, onboarding, migration25, migration26] = await Promise.all([
    readFile("public/mission-agent-latest.json", "utf8"),
    readFile("app/api/onboarding/connect/route.ts", "utf8"),
    readFile("db/migrations/0025_project_brain_governed_execution.sql", "utf8"),
    readFile("db/migrations/0026_remote_project_brain_transport.sql", "utf8"),
  ]);
  assert.equal(JSON.parse(manifest).sha256, missionAgentChecksum);
  assert.match(onboarding, new RegExp(missionAgentChecksum));
  assert.ok(migration25.length > 0);
  assert.ok(migration26.length > 0);
});
