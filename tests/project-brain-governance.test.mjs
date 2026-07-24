import assert from "node:assert/strict";
import test from "node:test";
import {
  projectBrainOperationPolicy,
  projectBrainRequestFingerprint,
  validateProjectBrainRequest,
} from "../integrations/project-brain/governance.ts";

test("read-only and repository-writing operations have explicit governance", () => {
  assert.equal(projectBrainOperationPolicy("get_summary").requiredPermission, "read");
  assert.equal(projectBrainOperationPolicy("get_summary").approvalType, undefined);
  assert.equal(projectBrainOperationPolicy("record_closure").requiredPermission, "write");
  assert.equal(projectBrainOperationPolicy("record_closure").approvalType, "project_brain_repository_write");
  assert.equal(projectBrainOperationPolicy("prepare_context", { preview: true }).requiredPermission, "read");
  assert.equal(projectBrainOperationPolicy("prepare_context", { preview: false }).requiredPermission, "write");
});

test("request fingerprint is stable and binds all changed arguments", () => {
  const a = projectBrainRequestFingerprint({ operation: "record_closure", arguments: { b: 2, a: 1 } });
  const b = projectBrainRequestFingerprint({ arguments: { a: 1, b: 2 }, operation: "record_closure" });
  const changed = projectBrainRequestFingerprint({ operation: "record_closure", arguments: { a: 1, b: 3 } });
  assert.equal(a, b);
  assert.notEqual(a, changed);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("writes require starting SHA and limits are bounded", () => {
  assert.throws(
    () =>
      validateProjectBrainRequest({
        operation: "record_closure",
        repositoryId: "repository",
        locationMode: "server",
        timeoutMs: 10,
        maxOutputBytes: 100,
      }),
    /starting SHA/,
  );
  assert.throws(
    () =>
      validateProjectBrainRequest({
        operation: "get_summary",
        repositoryId: "repository",
        locationMode: "server",
        timeoutMs: 10,
        maxOutputBytes: 10_000_001,
      }),
    /output limit/,
  );
});
