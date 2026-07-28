import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const repository = resolve(".");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const nodeDigest = `sha256:${"a".repeat(64)}`;
const verifierSource = await readFile(join(repository, "scripts/verify-v1-source-input.mjs"), "utf8");
const requiredFiles = {
  "package-lock.json": "{}\n",
  Dockerfile: `ARG NODE_IMAGE=example.com/node@${nodeDigest}\n`,
  "Dockerfile.project-brain-worker": `ARG NODE_IMAGE=example.com/node@${nodeDigest}\n`,
  "scripts/generate-v1-build-provenance.mjs": "export {};\n",
  "scripts/verify-v1-source-input.mjs": verifierSource,
  "infra/mission-control-v1-staging-runtime-stack.ts": "export {};\n",
  "infra/mission-control-v1-staging-bootstrap-stack.ts": "export {};\n",
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mission-control-v1-provenance-"));
  for (const [path, contents] of Object.entries(requiredFiles)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), contents);
  }
  const files = Object.entries(requiredFiles)
    .map(([path, contents]) => {
      const bytes = Buffer.from(contents);
      return {
        path,
        mode: "100644",
        gitObjectId: createHash("sha1")
          .update(Buffer.from(`blob ${bytes.length}\0`))
          .update(bytes)
          .digest("hex"),
        sha256: digest(contents),
      };
    })
    .sort(({ path: left }, { path: right }) => left.localeCompare(right));
  const gitTreeObject = (entries, prefix = "") => {
    const children = new Map();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const [name] = entry.path.slice(prefix.length).split("/");
      children.set(name, [...(children.get(name) ?? []), entry]);
    }
    const records = [...children.entries()]
      .map(([name, childEntries]) => {
        const direct = childEntries.find(({ path }) => path === `${prefix}${name}`);
        if (direct)
          return {
            sortName: name,
            bytes: Buffer.concat([Buffer.from(`${direct.mode} ${name}\0`), Buffer.from(direct.gitObjectId, "hex")]),
          };
        const oid = gitTreeObject(entries, `${prefix}${name}/`);
        return {
          sortName: `${name}/`,
          bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(oid, "hex")]),
        };
      })
      .sort((left, right) => Buffer.compare(Buffer.from(left.sortName), Buffer.from(right.sortName)));
    const body = Buffer.concat(records.map(({ bytes }) => bytes));
    return createHash("sha1")
      .update(Buffer.from(`tree ${body.length}\0`))
      .update(body)
      .digest("hex");
  };
  const archive = Buffer.from("fixture deterministic archive");
  await writeFile(join(root, "mission-control-source-archive.tar"), archive);
  const manifest = {
    schemaVersion: "mission-control-source-input-v1",
    sourceCommit: "1".repeat(40),
    sourceTreeObject: gitTreeObject(files),
    sourceArchiveDigest: createHash("sha256").update(archive).digest("hex"),
    sourceState: "clean",
    repositoryIdentity: "github.com/wallyweb/mission-control",
    buildWorkflowIdentity: "mission-control-v1-staging-test",
    lockfileDigest: digest(requiredFiles["package-lock.json"]),
    dockerfileDigests: {
      web: digest(requiredFiles.Dockerfile),
      projectBrain: digest(requiredFiles["Dockerfile.project-brain-worker"]),
    },
    baseImageDigests: { webNode: nodeDigest, projectBrainNode: nodeDigest },
    buildScriptDigests: {
      generateProvenance: digest(requiredFiles["scripts/generate-v1-build-provenance.mjs"]),
      verifySourceInput: digest(requiredFiles["scripts/verify-v1-source-input.mjs"]),
    },
    configurationTemplateDigests: {
      ecs: digest(requiredFiles["infra/mission-control-v1-staging-runtime-stack.ts"]),
      bootstrap: digest(requiredFiles["infra/mission-control-v1-staging-bootstrap-stack.ts"]),
    },
    files,
  };
  await writeFile(join(root, "mission-control-source-input.json"), `${JSON.stringify(manifest)}\n`);
  return { root, manifest };
}

test("source verifier binds every critical file and metadata digest", async () => {
  const { root } = await fixture();
  try {
    await exec("node", ["scripts/verify-v1-source-input.mjs"], { cwd: root });
    for (const path of ["package-lock.json", "Dockerfile", "scripts/generate-v1-build-provenance.mjs"]) {
      const original = await readFile(join(root, path), "utf8");
      await writeFile(join(root, path), `${original}modified\n`);
      await assert.rejects(
        () => exec("node", ["scripts/verify-v1-source-input.mjs"], { cwd: root }),
        /digest mismatch/,
      );
      await writeFile(join(root, path), original);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source verifier rejects forged critical metadata even when file list hashes are valid", async () => {
  const { root, manifest } = await fixture();
  try {
    manifest.lockfileDigest = "9".repeat(64);
    await writeFile(join(root, "mission-control-source-input.json"), `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      () => exec("node", ["scripts/verify-v1-source-input.mjs"], { cwd: root }),
      /metadata contradicts/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("context preparation refuses the current dirty tree before creating output", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mission-control-v1-dirty-"));
  const output = join(parent, "context");
  try {
    await assert.rejects(
      () =>
        exec(
          "node",
          [
            "scripts/prepare-v1-content-addressed-context.mjs",
            "--output",
            output,
            "--repository",
            "github.com/wallyweb/mission-control",
            "--workflow",
            "test",
          ],
          { cwd: repository },
        ),
      /clean checked-out commit/,
    );
    await assert.rejects(() => readFile(join(output, "mission-control-source-input.json")));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
