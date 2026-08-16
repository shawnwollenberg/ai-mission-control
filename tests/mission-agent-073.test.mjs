import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifact = await readFile(new URL("../public/mission-agent-0.7.3.mjs", import.meta.url));
const source = artifact.toString("utf8");

test("Mission Agent 0.7.3 is a distinct Analyze-only Grok adapter", () => {
  assert.equal(
    createHash("sha256").update(artifact).digest("hex"),
    "a4321cb88a98411941675e0a9343fc53710359f03ae4a79df0c1968accd555f4",
  );
  assert.equal(artifact.byteLength, 155078);
  assert.match(source, /const VERSION = "0\.7\.3"/);
  assert.match(source, /async function runGrok\(/);
  assert.match(source, /spawn\("grok"/);
  assert.match(source, /--sandbox",\s*"read-only"/);
  assert.match(source, /read_file,grep,list_dir/);
  assert.match(source, /Grok can analyze only/);
  assert.match(source, /config\.adapter !== "codex" && config\.adapter !== "grok"/);
});

test("Mission Agent 0.7.3 does not grant Grok change or consensus execution", () => {
  assert.match(source, /Repository changes currently require the Codex adapter/);
  assert.doesNotMatch(source, /missionType: consensus_plan/);
  assert.doesNotMatch(source, /--sandbox",\s*"workspace"/);
  assert.doesNotMatch(source, /--always-approve|--yolo/);
});

test("first-mission admission allows Grok analysis and rejects Grok change", async () => {
  const mission = await readFile(new URL("../application/onboarding-mission.ts", import.meta.url), "utf8");
  assert.match(mission, /mission_agent_adapter === "grok" && missionType !== "analysis"/);
  assert.match(mission, /Grok can analyze only/);
  assert.match(mission, /mission_agent_adapter !== "codex" && resource\.mission_agent_adapter !== "grok"/);
});
