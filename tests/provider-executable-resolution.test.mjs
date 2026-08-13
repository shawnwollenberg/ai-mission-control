import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveFrozenProviderExecutable } from "../lib/frozen-provider-executable-resolution.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("selects the one frozen Codex runtime when an npm-local stale shim appears first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mc-frozen-provider-resolution."));
  t.after(() => rm(root, { recursive: true, force: true }));
  const createInstall = async (name, launcherBytes, nativeBytes) => {
    const install = join(root, name, "node_modules", "@openai", "codex");
    const launcher = join(install, "bin", "codex.js");
    const native = join(
      install,
      "node_modules",
      "@openai",
      "codex-darwin-arm64",
      "vendor",
      "aarch64-apple-darwin",
      "bin",
      "codex",
    );
    await mkdir(dirname(launcher), { recursive: true });
    await mkdir(dirname(native), { recursive: true });
    await writeFile(launcher, launcherBytes);
    await writeFile(native, nativeBytes);
    const lexical = join(root, name, "bin", "codex");
    await mkdir(dirname(lexical), { recursive: true });
    await symlink(launcher, lexical);
    return { lexical, native };
  };
  const stale = await createInstall("stale", "same-launcher", "stale-native");
  const frozen = await createInstall("frozen", "same-launcher", "frozen-native");
  const selected = await resolveFrozenProviderExecutable({
    provider: "codex",
    lexicalCandidates: [stale.lexical, frozen.lexical],
    expected: {
      launcherSha256: sha256("same-launcher"),
      invokedExecutableSha256: sha256("frozen-native"),
    },
  });
  assert.equal(selected.lexical, frozen.lexical);
  assert.equal(selected.invokedExecutable, await realpath(frozen.native));
});

test("fails closed when no frozen runtime matches", async () => {
  await assert.rejects(
    resolveFrozenProviderExecutable({
      provider: "codex",
      lexicalCandidates: ["/does/not/exist"],
      expected: { launcherSha256: "0".repeat(64), invokedExecutableSha256: "0".repeat(64) },
    }),
    /exactly one frozen runtime identity/,
  );
});
