import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function resolveFrozenProviderExecutable({
  provider,
  lexicalCandidates,
  expected,
  read = readFile,
  canonicalize = realpath,
}) {
  const matchingCandidates = [];
  for (const lexicalCandidate of lexicalCandidates) {
    try {
      const executable = await canonicalize(lexicalCandidate);
      const installationRoot = provider === "codex" ? resolve(dirname(executable), "..") : resolve(dirname(executable));
      const invokedExecutable = await canonicalize(
        provider === "codex"
          ? resolve(installationRoot, "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex")
          : executable,
      );
      const launcherSha256 = sha256(await read(executable));
      const invokedExecutableSha256 = sha256(await read(invokedExecutable));
      if (launcherSha256 === expected.launcherSha256 && invokedExecutableSha256 === expected.invokedExecutableSha256)
        matchingCandidates.push({
          lexical: lexicalCandidate,
          executable,
          installationRoot,
          invokedExecutable,
          launcherSha256,
          invokedExecutableSha256,
        });
    } catch {
      // Broken and nonmatching PATH entries are ineligible, never authoritative fallbacks.
    }
  }
  const candidatesByInvokedExecutable = new Map(
    matchingCandidates.map((candidate) => [candidate.invokedExecutable, candidate]),
  );
  if (candidatesByInvokedExecutable.size !== 1)
    throw new Error(`${provider} executable resolution did not yield exactly one frozen runtime identity`);
  return candidatesByInvokedExecutable.values().next().value;
}
