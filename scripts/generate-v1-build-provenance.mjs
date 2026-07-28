import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function digestTree(root) {
  const entries = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const info = await stat(path);
      if (info.isDirectory()) await walk(path);
      else if (name !== "mission-control-build-provenance.json")
        entries.push([relative(root, path), hash(await readFile(path))]);
    }
  }
  await walk(root);
  return hash(entries.map(([name, digest]) => `${name}\0${digest}\n`).join(""));
}

const sourceCommit = required("MC_SOURCE_COMMIT");
const sourceState = required("MC_SOURCE_STATE");
const buildMode = required("MC_BUILD_MODE");
const sourceInputBytes = await readFile("mission-control-source-input.json");
const sourceInput = JSON.parse(sourceInputBytes.toString("utf8"));
if (
  !/^[a-f0-9]{40}$/.test(sourceCommit) ||
  !["clean", "dirty"].includes(sourceState) ||
  !["production", "disposable"].includes(buildMode) ||
  (buildMode === "production" && sourceState !== "clean") ||
  sourceInput.schemaVersion !== "mission-control-source-input-v1" ||
  sourceInput.sourceCommit !== sourceCommit ||
  sourceInput.sourceState !== sourceState
)
  throw new Error("Build source identity is invalid.");
const provenance = {
  schemaVersion: "mission-control-build-provenance-v2",
  sourceCommit,
  sourceTreeObject: sourceInput.sourceTreeObject,
  sourceArchiveDigest: sourceInput.sourceArchiveDigest,
  sourceInputManifestDigest: hash(sourceInputBytes),
  sourceState,
  buildMode,
  buildTimestamp: required("MC_BUILD_TIMESTAMP"),
  builderIdentity: required("MC_BUILDER_IDENTITY"),
  repositoryIdentity: sourceInput.repositoryIdentity,
  buildWorkflowIdentity: sourceInput.buildWorkflowIdentity,
  lockfileDigest: sourceInput.lockfileDigest,
  dockerfileDigests: sourceInput.dockerfileDigests,
  baseImageDigests: sourceInput.baseImageDigests,
  buildScriptDigests: sourceInput.buildScriptDigests,
  configurationTemplateDigests: sourceInput.configurationTemplateDigests,
  applicationBundleDigest: await digestTree(process.env.MC_APPLICATION_BUNDLE_ROOT ?? ".next/standalone"),
  productionContractVersion: "mission-control-production-rollout-v1",
  databaseCompatibility: { minimum: "0028", maximum: "0030" },
};
await writeFile(
  join(process.env.MC_APPLICATION_BUNDLE_ROOT ?? ".next/standalone", "mission-control-build-provenance.json"),
  `${JSON.stringify(provenance)}\n`,
  { mode: 0o444 },
);
process.stdout.write(`${JSON.stringify(provenance)}\n`);
