import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Mission Agent publication is exact, non-force, evidence-bound, and separate from merge", async () => {
  const source = await readFile("public/mission-agent-0.6.0.mjs", "utf8");
  assert.match(source, /The local branch or commit changed after Publish for Review was approved/);
  assert.match(source, /sha256\(patch\.stdout\)/);
  assert.match(source, /Force push is never permitted/);
  assert.match(
    source,
    /\["push", publication\.remote, `\$\{publication\.commit\}:refs\/heads\/\$\{publication\.branch\}`\]/,
  );
  assert.doesNotMatch(source, /--force|-f", publication/);
  assert.doesNotMatch(source, /gh", \["pr", "merge"/);
});

test("pull-request evidence includes traceability and the bounded authority statement", async () => {
  const source = await readFile("application/action-commands.ts", "utf8");
  for (const heading of [
    "Objective",
    "Source recommendation",
    "Acceptance criteria",
    "Implementation evidence",
    "Validation",
    "Limitations and risks",
    "Rollback",
    "Mission traceability",
  ])
    assert.match(source, new RegExp(heading));
  assert.match(source, /Human-approved authority: publish this exact local commit for review/);
  assert.match(source, /evidenceChecksum/);
});
