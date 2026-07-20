import assert from "node:assert/strict";
import test from "node:test";
import { assessRepositoryHealth } from "../domain/repository-health.ts";

const observed = (dimension, status = "strength", severity = "low") => ({
  dimension,
  status,
  severity,
  summary: `${dimension} was inspected`,
  evidence: [{ path: `${dimension}.md`, line: 1 }],
});

test("repository health scoring is deterministic and missing dimensions remain unknown", () => {
  const result = assessRepositoryHealth([
    observed("architecture"),
    observed("tests", "risk", "high"),
    { dimension: "security", status: "unknown", severity: "low", summary: "No security evidence", evidence: [] },
  ]);
  assert.equal(result.dimensions.architecture.score, 100);
  assert.equal(result.dimensions.tests.score, 72);
  assert.equal(result.dimensions.security.score, null);
  assert.equal(result.dimensions.ci.score, null);
  assert.equal(result.score, 86);
  assert.equal(result.confidence, 36);
  assert.equal(result.scoringVersion, "repository-health-v1");
});

test("repository health rejects unsupported and unsafe evidence", () => {
  assert.throws(() => assessRepositoryHealth([observed("morale")]), /unsupported dimension/);
  assert.throws(
    () => assessRepositoryHealth([{ ...observed("security", "risk", "high"), evidence: [{ path: "../secret" }] }]),
    /repository-relative/,
  );
});
