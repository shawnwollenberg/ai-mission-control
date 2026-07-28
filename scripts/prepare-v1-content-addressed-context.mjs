import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

const exec = promisify(execFile);
const args = parseArgs({
  options: {
    commit: { type: "string", default: "HEAD" },
    output: { type: "string" },
    repository: { type: "string" },
    workflow: { type: "string" },
  },
  strict: true,
}).values;
if (!args.output || !args.repository || !args.workflow)
  throw new Error("--output, --repository, and --workflow are required.");

const output = resolve(args.output);
if (output === "/" || output === resolve(".")) throw new Error("Refusing an unsafe build-context output path.");
const run = async (...command) =>
  (await exec("git", command, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })).stdout.trim();
const sourceCommit = await run("rev-parse", "--verify", `${args.commit}^{commit}`);
const currentCommit = await run("rev-parse", "--verify", "HEAD");
const status = await run("status", "--porcelain=v1", "--untracked-files=all");
if (status || sourceCommit !== currentCommit)
  throw new Error("Content-addressed production context requires the clean checked-out commit.");
const sourceTreeObject = await run("rev-parse", `${sourceCommit}^{tree}`);
const treeOutput = (
  await exec("git", ["ls-tree", "-r", "-z", sourceCommit], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
).stdout;
const tracked = treeOutput
  .split("\0")
  .filter(Boolean)
  .map((entry) => {
    const match = /^([0-9]+) (blob) ([a-f0-9]{40})\t(.+)$/.exec(entry);
    if (!match) throw new Error("Git source tree contains an unsupported entry.");
    return { mode: match[1], gitObjectId: match[3], path: match[4] };
  })
  .sort(({ path: left }, { path: right }) => left.localeCompare(right));

const scratch = await mkdtemp(join(tmpdir(), "mission-control-v1-source-"));
const archive = join(scratch, "source.tar");
try {
  await exec("git", ["archive", "--format=tar", "--output", archive, sourceCommit]);
  const archiveBytes = await readFile(archive);
  const sourceArchiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
  await rm(output, { recursive: true, force: true });
  await exec("mkdir", ["-p", output]);
  await exec("tar", ["-xf", archive, "-C", output]);
  const files = [];
  for (const entry of tracked) {
    const path = join(output, entry.path);
    const info = await lstat(path);
    const bytes =
      entry.mode === "120000"
        ? Buffer.from(await readlink(path))
        : info.isFile()
          ? await readFile(path)
          : (() => {
              throw new Error(`Archived source entry has an unsupported type: ${entry.path}.`);
            })();
    files.push({ ...entry, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const lookup = new Map(files.map(({ path, sha256 }) => [path, sha256]));
  const required = (path) => {
    const digest = lookup.get(path);
    if (!digest) throw new Error(`Required source input is missing: ${path}.`);
    return digest;
  };
  const pinnedBaseImage = async (path) => {
    const match = (await readFile(join(output, path), "utf8")).match(/^ARG NODE_IMAGE=[^@\s]+@(sha256:[a-f0-9]{64})$/m);
    if (!match) throw new Error(`Build input lacks an immutable NODE_IMAGE digest: ${path}.`);
    return match[1];
  };
  const manifest = {
    schemaVersion: "mission-control-source-input-v1",
    sourceCommit,
    sourceTreeObject,
    sourceArchiveDigest,
    sourceState: "clean",
    repositoryIdentity: args.repository,
    buildWorkflowIdentity: args.workflow,
    lockfileDigest: required("package-lock.json"),
    dockerfileDigests: {
      web: required("Dockerfile"),
      projectBrain: required("Dockerfile.project-brain-worker"),
    },
    baseImageDigests: {
      webNode: await pinnedBaseImage("Dockerfile"),
      projectBrainNode: await pinnedBaseImage("Dockerfile.project-brain-worker"),
    },
    buildScriptDigests: {
      generateProvenance: required("scripts/generate-v1-build-provenance.mjs"),
      verifySourceInput: required("scripts/verify-v1-source-input.mjs"),
    },
    configurationTemplateDigests: {
      ecs: required("infra/mission-control-v1-staging-runtime-stack.ts"),
      bootstrap: required("infra/mission-control-v1-staging-bootstrap-stack.ts"),
    },
    files,
  };
  await writeFile(join(output, "mission-control-source-input.json"), `${JSON.stringify(manifest)}\n`, {
    mode: 0o444,
    flag: "wx",
  });
  await copyFile(archive, join(output, "mission-control-source-archive.tar"));
  process.stdout.write(
    `${JSON.stringify({ output, sourceCommit, sourceTreeObject, sourceArchiveDigest, fileCount: files.length })}\n`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
