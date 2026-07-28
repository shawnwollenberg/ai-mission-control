import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative } from "node:path";

const SHA = /^[a-f0-9]{64}$/;
const manifest = JSON.parse(await readFile("mission-control-source-input.json", "utf8"));
if (
  manifest.schemaVersion !== "mission-control-source-input-v1" ||
  !/^[a-f0-9]{40}$/.test(manifest.sourceCommit) ||
  !/^[a-f0-9]{40}$/.test(manifest.sourceTreeObject) ||
  !SHA.test(manifest.sourceArchiveDigest) ||
  manifest.sourceState !== "clean" ||
  !manifest.repositoryIdentity ||
  !manifest.buildWorkflowIdentity ||
  Object.values(manifest.baseImageDigests ?? {}).length !== 2 ||
  Object.values(manifest.baseImageDigests).some((digest) => !/^sha256:[a-f0-9]{64}$/.test(digest)) ||
  !Array.isArray(manifest.files) ||
  manifest.files.length < 1
)
  throw new Error("Content-addressed source manifest is malformed.");

const seen = new Set();
const verified = new Map();
const treeEntries = [];
for (const entry of manifest.files) {
  if (
    !entry ||
    typeof entry.path !== "string" ||
    entry.path.startsWith("/") ||
    entry.path.split("/").includes("..") ||
    !/^(100644|100755|120000)$/.test(entry.mode) ||
    !/^[a-f0-9]{40}$/.test(entry.gitObjectId) ||
    !SHA.test(entry.sha256) ||
    seen.has(entry.path)
  )
    throw new Error("Content-addressed source manifest contains an unsafe entry.");
  seen.add(entry.path);
  const info = await lstat(entry.path);
  const bytes =
    entry.mode === "120000"
      ? Buffer.from(await readlink(entry.path))
      : info.isFile()
        ? await readFile(entry.path)
        : (() => {
            throw new Error(`Source input type mismatch: ${entry.path}.`);
          })();
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== entry.sha256) throw new Error(`Source input digest mismatch: ${entry.path}.`);
  const gitObjectId = createHash("sha1")
    .update(Buffer.from(`blob ${bytes.length}\0`))
    .update(bytes)
    .digest("hex");
  if (gitObjectId !== entry.gitObjectId) throw new Error(`Git blob identity mismatch: ${entry.path}.`);
  verified.set(entry.path, actual);
  treeEntries.push(entry);
}
const actualPaths = [];
async function walk(directory) {
  for (const name of (await readdir(directory)).sort()) {
    if (directory === "." && ["mission-control-source-input.json", "mission-control-source-archive.tar"].includes(name))
      continue;
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isDirectory()) await walk(path);
    else if (info.isFile() || info.isSymbolicLink()) actualPaths.push(relative(".", path));
    else throw new Error(`Build context contains an unsupported entry: ${path}.`);
  }
}
await walk(".");
if (JSON.stringify(actualPaths.sort()) !== JSON.stringify([...seen].sort()))
  throw new Error("Build context contains an unlisted or missing source input.");
const archive = await readFile("mission-control-source-archive.tar");
if (createHash("sha256").update(archive).digest("hex") !== manifest.sourceArchiveDigest)
  throw new Error("Deterministic source archive digest does not match.");
function gitTreeObject(entries, prefix = "") {
  const children = new Map();
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const remainder = entry.path.slice(prefix.length);
    const [name] = remainder.split("/");
    const child = children.get(name) ?? [];
    child.push(entry);
    children.set(name, child);
  }
  const records = [...children.entries()]
    .map(([name, childEntries]) => {
      const direct = childEntries.find(({ path }) => path === `${prefix}${name}`);
      if (direct)
        return {
          sortName: name,
          bytes: Buffer.concat([Buffer.from(`${direct.mode} ${name}\0`), Buffer.from(direct.gitObjectId, "hex")]),
        };
      const objectId = gitTreeObject(entries, `${prefix}${name}/`);
      return {
        sortName: `${name}/`,
        bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(objectId, "hex")]),
      };
    })
    .sort((left, right) => Buffer.compare(Buffer.from(left.sortName), Buffer.from(right.sortName)));
  const body = Buffer.concat(records.map(({ bytes }) => bytes));
  return createHash("sha1")
    .update(Buffer.from(`tree ${body.length}\0`))
    .update(body)
    .digest("hex");
}
if (gitTreeObject(treeEntries) !== manifest.sourceTreeObject)
  throw new Error("Reconstructed Git tree does not match the declared source tree object.");
for (const required of [
  "package-lock.json",
  "Dockerfile",
  "Dockerfile.project-brain-worker",
  "scripts/generate-v1-build-provenance.mjs",
  "scripts/verify-v1-source-input.mjs",
  "infra/mission-control-v1-staging-runtime-stack.ts",
  "infra/mission-control-v1-staging-bootstrap-stack.ts",
])
  if (!seen.has(required)) throw new Error(`Required content-addressed source input is absent: ${required}.`);
if (
  manifest.lockfileDigest !== verified.get("package-lock.json") ||
  manifest.dockerfileDigests?.web !== verified.get("Dockerfile") ||
  manifest.dockerfileDigests?.projectBrain !== verified.get("Dockerfile.project-brain-worker") ||
  manifest.buildScriptDigests?.generateProvenance !== verified.get("scripts/generate-v1-build-provenance.mjs") ||
  manifest.buildScriptDigests?.verifySourceInput !== verified.get("scripts/verify-v1-source-input.mjs") ||
  manifest.configurationTemplateDigests?.ecs !== verified.get("infra/mission-control-v1-staging-runtime-stack.ts") ||
  manifest.configurationTemplateDigests?.bootstrap !==
    verified.get("infra/mission-control-v1-staging-bootstrap-stack.ts")
)
  throw new Error("Content-addressed source metadata contradicts verified file bytes.");
for (const [path, field] of [
  ["Dockerfile", "webNode"],
  ["Dockerfile.project-brain-worker", "projectBrainNode"],
]) {
  const match = (await readFile(path, "utf8")).match(/^ARG NODE_IMAGE=[^@\s]+@(sha256:[a-f0-9]{64})$/m);
  if (!match || manifest.baseImageDigests[field] !== match[1])
    throw new Error(`Pinned base image metadata contradicts ${path}.`);
}
process.stdout.write(
  `${JSON.stringify({ sourceCommit: manifest.sourceCommit, sourceTreeObject: manifest.sourceTreeObject, verifiedFiles: seen.size })}\n`,
);
