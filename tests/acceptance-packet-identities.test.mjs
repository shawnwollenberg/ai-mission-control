import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalHash } from "../lib/canonical-json.ts";
import { runtimeModeDefinitionIdentities } from "../lib/acceptance-packet-identities.ts";

test("runtime-mode registry identity is explicitly the raw file SHA", async () => {
  const bytes = await readFile("domain/runtime-mode-definition.json");
  const identities = await runtimeModeDefinitionIdentities();
  assert.equal(identities.rawFileSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(identities.canonicalJsonSha256, canonicalHash(JSON.parse(bytes.toString("utf8"))));
  assert.notEqual(identities.rawFileSha256, identities.canonicalJsonSha256);

  const schema = JSON.parse(await readFile("domain/disposable-acceptance-registry.schema.json", "utf8"));
  assert.ok(schema.$defs.artifact.required.includes("runtimeModeDefinitionFileSha256"));
  assert.equal(schema.$defs.artifact.required.includes("runtimeModeDefinitionSha256"), false);
});
