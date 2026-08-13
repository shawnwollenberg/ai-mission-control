import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { format } from "prettier";

const repositoryRoot = await realpath(resolve("."));
const manifestPath = resolve(repositoryRoot, "domain/mission-control-acceptance-source-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== "mission-control-acceptance-source-manifest/1" ||
  manifest.scope !== "disposable_consensus_acceptance_security_boundary" ||
  !/^[a-f0-9]{40}$/.test(manifest.sourceBase) ||
  !Array.isArray(manifest.includedRoots) ||
  !Array.isArray(manifest.includedFiles) ||
  manifest.excludedFiles?.length !== 1 ||
  manifest.excludedFiles[0] !== "domain/mission-control-acceptance-source-manifest.json"
)
  throw new Error("Refusing to generate an invalid acceptance source manifest");

const excluded = new Set(manifest.excludedFiles);
const paths = new Set();
const visit = async (candidate) => {
  const resolved = await realpath(candidate);
  if (resolved !== repositoryRoot && !resolved.startsWith(`${repositoryRoot}${sep}`))
    throw new Error(`Acceptance source path escapes the repository: ${candidate}`);
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) throw new Error(`Acceptance source path is a symlink: ${candidate}`);
  const relativePath = relative(repositoryRoot, candidate).split(sep).join("/");
  if (info.isDirectory()) {
    for (const entry of (await readdir(candidate)).sort()) await visit(resolve(candidate, entry));
  } else if (info.isFile() && !excluded.has(relativePath)) paths.add(relativePath);
  else if (!info.isFile()) throw new Error(`Acceptance source path is not a regular file: ${candidate}`);
};
for (const root of manifest.includedRoots) await visit(resolve(repositoryRoot, root));
for (const file of manifest.includedFiles) await visit(resolve(repositoryRoot, file));

const files = {};
for (const path of Array.from(paths).sort())
  files[path] = createHash("sha256")
    .update(await readFile(resolve(repositoryRoot, path)))
    .digest("hex");
const bytes = await format(JSON.stringify({ ...manifest, files }), { parser: "json" });
await writeFile(manifestPath, bytes, { mode: 0o644 });
console.log(JSON.stringify({ event: "acceptance_source_manifest_generated", fileCount: Object.keys(files).length }));
