#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Mock provider runtime requires ${name}`);
  return value;
};
if (process.env.APP_ENV !== "disposable_acceptance") throw new Error("Mock provider runtime is acceptance-only");
if (required("MISSION_AGENT_PROVIDER_RUNTIME_MODE") !== "mock_provider_acceptance")
  throw new Error("Mock provider runtime mode is not explicit");

const context = JSON.parse(Buffer.from(required("MISSION_AGENT_MOCK_INVOCATION"), "base64url").toString("utf8"));
if (
  context.schemaVersion !== "mission-agent-mock-provider-invocation/1" ||
  !["mock_codex", "mock_claude_code"].includes(context.mockProvider) ||
  context.evidenceSource !== "mock_provider_runtime" ||
  context.authenticatedProviderInvoked !== false ||
  context.productionAuthority !== false
)
  throw new Error("Mock provider invocation binding is invalid");

const authority = context.filesystemWriteAuthority;
const unsignedAuthority =
  authority && Object.fromEntries(Object.entries(authority).filter(([key]) => key !== "authoritySha256"));
const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
};
if (
  authority?.schemaVersion !== "filesystem-write-authority/1" ||
  sha256(canonicalJson(unsignedAuthority)) !== authority.authoritySha256 ||
  authority.providerAttemptId !== context.providerAttemptId
)
  throw new Error("Mock provider filesystem-write authority binding is invalid");
const inside = (root, target) => {
  const suffix = relative(root, target);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
};
const canonicalCreationTarget = (requestedPath) => {
  if (!isAbsolute(requestedPath)) throw new Error("FILESYSTEM_WRITE_FORBIDDEN");
  let cursor = normalize(resolve(requestedPath));
  const missing = [];
  for (;;) {
    try {
      lstatSync(cursor);
      const existing = realpathSync(cursor);
      if (missing.length && !statSync(existing).isDirectory()) throw new Error("FILESYSTEM_WRITE_FORBIDDEN");
      return join(existing, ...missing.reverse());
    } catch (error) {
      if (error?.message === "FILESYSTEM_WRITE_FORBIDDEN" || ["ELOOP", "ENOTDIR"].includes(error?.code))
        throw new Error("FILESYSTEM_WRITE_FORBIDDEN");
      if (error?.code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor || cursor === parse(cursor).root) throw new Error("FILESYSTEM_WRITE_FORBIDDEN");
      missing.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
};
const filesystemDecision = (requestedPath, operation) => {
  const canonicalTargetPath = canonicalCreationTarget(requestedPath);
  const canonicalApprovedRoots = authority.approvedWritableRoots.map((root) => realpathSync(root)).sort();
  const allowed = canonicalApprovedRoots.some((root) => inside(root, canonicalTargetPath));
  const decision = {
    schemaVersion: "filesystem-write-decision/1",
    authoritySha256: authority.authoritySha256,
    providerAttemptId: context.providerAttemptId,
    operation,
    requestedPathIdentitySha256: sha256(canonicalJson({ requestedPath })),
    canonicalTargetPath,
    canonicalApprovedRoots,
    allowed,
    reasonCode: allowed ? null : "FILESYSTEM_WRITE_FORBIDDEN",
  };
  if (!allowed)
    throw Object.assign(new Error("FILESYSTEM_WRITE_FORBIDDEN"), {
      classification: "provider_filesystem_write_forbidden",
      reasonCode: "FILESYSTEM_WRITE_FORBIDDEN",
      decision,
    });
  return decision;
};
const governedWriteFileSync = (path, bytes, options) => {
  const decision = filesystemDecision(path, existsSync(path) ? "modify" : "create");
  writeFileSync(path, bytes, options);
  return decision;
};

if (context.operation === "implementation" && context.filesystemWriteProbe) {
  const { allowedPath, deniedPath, observationPath } = context.filesystemWriteProbe;
  const allowedBeforeExists = existsSync(allowedPath);
  const allowedDecision = governedWriteFileSync(allowedPath, `allowed:${context.providerAttemptId}\n`, { mode: 0o600 });
  const deniedBeforeExists = existsSync(deniedPath);
  const deniedBeforeSha256 = deniedBeforeExists ? sha256(readFileSync(deniedPath)) : null;
  let deniedError;
  try {
    governedWriteFileSync(deniedPath, "forbidden\n", { mode: 0o600 });
    throw new Error("Out-of-root mock provider write unexpectedly succeeded");
  } catch (error) {
    if (error?.message !== "FILESYSTEM_WRITE_FORBIDDEN") throw error;
    deniedError = error;
  }
  const descendant = spawnSync(
    process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], 'forbidden descendant\\n')", deniedPath],
    { encoding: "utf8", timeout: 5_000 },
  );
  if (descendant.status === 0 || existsSync(deniedPath))
    throw new Error("Out-of-root mock provider descendant write unexpectedly succeeded");
  const allowedBytes = readFileSync(allowedPath);
  const deniedAfterExists = existsSync(deniedPath);
  if (
    deniedError?.classification !== "provider_filesystem_write_forbidden" ||
    deniedError?.reasonCode !== "FILESYSTEM_WRITE_FORBIDDEN" ||
    deniedError?.decision?.allowed !== false ||
    deniedBeforeExists ||
    deniedAfterExists
  )
    throw new Error("Mock provider filesystem-write probe did not produce the governed rejection");
  const recordedAt = new Date().toISOString();
  const unsignedObservation = {
    schemaVersion: "filesystem-write-observation/1",
    observationSchemaIdentitySha256: sha256("filesystem-write-observation/1"),
    acceptanceRunId: authority.acceptanceRunId,
    candidateArtifactSha256: authority.candidateArtifactSha256,
    missionId: context.missionId,
    childMissionId: authority.childMissionId,
    executionId: authority.executionId,
    assignmentId: context.assignmentId,
    assignmentAttempt: context.attemptId,
    providerAttemptId: context.providerAttemptId,
    provider: context.requestedProvider,
    model: context.requestedModel,
    runtimeProfileId: context.runtimeProfile,
    authority,
    authoritySha256: authority.authoritySha256,
    approvedWritableRoots: authority.approvedWritableRoots,
    requestedTargetCanonicalPath: deniedError.decision.canonicalTargetPath,
    operation: "create",
    existsBefore: deniedBeforeExists,
    errorClassification: deniedError.classification,
    reasonCode: deniedError.reasonCode,
    existsAfter: deniedAfterExists,
    targetSha256: null,
    recordedAt,
    allowedWrite: {
      ...allowedDecision,
      existedBefore: allowedBeforeExists,
      existsAfter: existsSync(allowedPath),
      targetSha256After: sha256(allowedBytes),
    },
    deniedWrite: {
      ...deniedError.decision,
      existedBefore: deniedBeforeExists,
      existsAfter: deniedAfterExists,
      targetSha256Before: deniedBeforeSha256,
      targetSha256After: deniedAfterExists ? sha256(readFileSync(deniedPath)) : null,
    },
    descendantWrite: {
      attempted: true,
      allowed: false,
      exitStatus: descendant.status,
      terminationSignal: descendant.signal,
      targetExistsAfter: deniedAfterExists,
      reasonCode: "FILESYSTEM_WRITE_FORBIDDEN",
    },
  };
  const observationIdentitySha256 = sha256(canonicalJson(unsignedObservation));
  const observation = {
    ...unsignedObservation,
    observationIdentitySha256,
    evidenceSeal: { algorithm: "sha256", subjectSha256: observationIdentitySha256 },
  };
  const canonicalObservation = canonicalJson(observation);
  if (
    /Authorization\s*:|\bBearer\s+|"(?:password|access_token|refresh_token|client_secret|leaseToken)"\s*:/i.test(
      canonicalObservation,
    )
  )
    throw new Error("Mock provider filesystem-write observation contains prohibited secret material");
  governedWriteFileSync(observationPath, `${canonicalObservation}\n`, { mode: 0o600 });
  filesystemDecision(allowedPath, "delete");
  unlinkSync(allowedPath);
}

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const scenario = process.env.MISSION_AGENT_MOCK_SCENARIO ?? "success";
if (scenario === "provider_restart_once") {
  const stateRoot = required("MISSION_AGENT_MOCK_SCENARIO_STATE_ROOT");
  const marker = resolve(stateRoot, `${context.assignmentId}-provider-restart-observed`);
  const contamination = resolve(process.cwd(), ".provider-generation-1-contamination");
  const outputPath = value("-o");
  try {
    filesystemDecision(marker, "create");
    const descriptor = openSync(marker, "wx", 0o600);
    closeSync(descriptor);
    governedWriteFileSync(contamination, `failed provider generation ${context.providerAttemptId}\n`, { mode: 0o600 });
    if (outputPath) governedWriteFileSync(outputPath, "incomplete generation-1 output\n", { mode: 0o600 });
    process.kill(process.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (existsSync(contamination)) throw new Error("failed provider generation contaminated its replacement");
    governedWriteFileSync(
      resolve(stateRoot, `${context.assignmentId}-replacement-observed-clean-worktree`),
      JSON.stringify({ providerAttemptId: context.providerAttemptId, contaminationAbsent: true }),
      { mode: 0o600 },
    );
  }
}
if (scenario === "lease_loss_wait") await new Promise((done) => setTimeout(done, 35_000));
if (scenario === "timeout")
  await new Promise(() => {
    setInterval(() => {}, 60_000);
  });
if (scenario === "provider_crash") process.kill(process.pid, "SIGKILL");
if (scenario === "provider_authentication_failure") {
  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      is_error: true,
      terminal_reason: "api_error",
      api_error_status: 401,
      error_code: "oauth_token_expired",
      result: "Provider authentication is unavailable.",
    })}\n`,
  );
  process.exit(1);
}
if (scenario === "delayed_output") await new Promise((done) => setTimeout(done, 750));
if (["wrong_model", "stale_lease", "stale_fencing", "conflicting_receipt", "repository_drift"].includes(scenario))
  throw new Error(`mock fault: ${scenario}`);

const schemaText =
  value("--json-schema") ?? (value("--output-schema") ? readFileSync(value("--output-schema"), "utf8") : null);
const fromSchema = (schema, key = "") => {
  if (schema.enum) return schema.enum[0];
  if (schema.type === "string") return schema.pattern?.includes("64") ? "a".repeat(64) : `mock-${key || "value"}`;
  if (schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "array") return [];
  if (schema.type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([name, child]) => [name, fromSchema(child, name)]),
    );
  return null;
};

if (schemaText) {
  const schema = JSON.parse(schemaText);
  const output = fromSchema(schema);
  if (scenario === "wrong_assignment" && "assignment_id" in output)
    output.assignment_id = "00000000-0000-4000-8000-ffffffffffff";
  if (scenario === "wrong_snapshot" && "repository_snapshot" in output) output.repository_snapshot = "f".repeat(64);
  if (scenario === "wrong_context" && "context_pack_hash" in output) output.context_pack_hash = "f".repeat(64);
  if (scenario === "wrong_plan_hash" && "canonical_plan_hash" in output) output.canonical_plan_hash = "f".repeat(64);
  const version = output.schema_version;
  if (version === "consensus-plan-proposal/1" || version === "consensus-plan-revision/1") {
    output.problem_definition = "Deliver the approved runtime-v6 change without broadening authority.";
    output.proposed_approach = "Use the existing governed command and event path with exact bindings.";
    output.implementation_steps = ["Apply the bounded change", "Validate the exact acceptance criteria"];
    output.validation_plan = ["Run the governed validation commands"];
    output.rollback_plan = ["Remove the bounded local change"];
    output.confidence = 0.9;
  }
  if (version === "consensus-plan-critique/1") {
    output.blocking_objections = [
      {
        id: "mock-objection-validation",
        category: "testing",
        description: "The proposal must bind validation evidence explicitly.",
        required_change: "Add an exact validation step and rollback evidence.",
      },
    ];
    output.verdict = "accept_with_changes";
    output.confidence = 0.9;
  }
  if (version === "consensus-plan-revision/1") output.resolved_objection_ids = ["mock-objection-validation"];
  if (version === "canonical-implementation-plan/1") {
    output.architecture = "Bounded implementation through existing Mission Control authority and event paths.";
    output.ordered_implementation_steps = ["Create one reviewable local change", "Run exact validation"];
    output.validation_plan = ["npm test"];
    output.rollback_plan = ["Revert the local candidate change"];
  }
  if (version === "canonical-plan-verdict/1") {
    output.verdict = "approve";
    output.confidence = 0.95;
  }
  if (scenario.startsWith("malformed_")) {
    process.stdout.write("{malformed");
    process.exit(0);
  }
  const bytes = JSON.stringify(output);
  const outputPath = value("-o");
  if (outputPath) {
    filesystemDecision(dirname(resolve(outputPath)), "modify");
    mkdirSync(dirname(resolve(outputPath)), { recursive: true });
    governedWriteFileSync(outputPath, bytes, { mode: 0o600 });
    process.stdout.write(
      `${JSON.stringify({ type: "mock_provider_result", evidence_source: "mock_provider_runtime", sha256: sha256(bytes) })}\n`,
    );
  } else {
    process.stdout.write(
      JSON.stringify({
        structured_output: output,
        result: bytes,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        mock_provider_identity: context.mockProvider,
        evidence_source: "mock_provider_runtime",
        authenticated_provider_invoked: false,
      }),
    );
  }
} else {
  const outputPath = value("-o");
  const packagePath = resolve(process.cwd(), "package.json");
  const sourcePath = resolve(process.cwd(), "src", "retention.js");
  const testPath = resolve(process.cwd(), "test", "retention.test.js");
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  const baselineSource = readFileSync(sourcePath, "utf8");
  if (
    packageJson.name !== "consensus-acceptance-fixture" ||
    !baselineSource.includes('throw new TypeError("tier must be an explicitly supported retention tier")')
  )
    throw new Error("Mock implementation refuses a repository outside the exact disposable acceptance fixture");
  governedWriteFileSync(
    sourcePath,
    `const RETENTION_DAYS = Object.freeze({ critical: 30, standard: 7 });

export function currentRetentionDays(tier) {
  if (typeof tier !== "string" || !Object.hasOwn(RETENTION_DAYS, tier)) {
    throw new TypeError("tier must be an explicitly supported retention tier");
  }
  return RETENTION_DAYS[tier];
}

export function recommendRetentionPolicy({ tier, eventVolume = 0, storageBudgetGb = Infinity } = {}) {
  const baselineDays = currentRetentionDays(tier);
  const volumeAdjustedDays = eventVolume > 1_000_000 ? Math.floor(baselineDays / 2) : baselineDays;
  const budgetAdjustedDays = storageBudgetGb < 1 ? Math.floor(volumeAdjustedDays / 2) : volumeAdjustedDays;
  const days = Math.max(1, Math.min(90, budgetAdjustedDays));
  return {
    days,
    rationale: \`tier=\${tier};eventVolume=\${eventVolume};storageBudgetGb=\${storageBudgetGb};baselineDays=\${baselineDays}\`,
  };
}
`,
    { mode: 0o600 },
  );
  governedWriteFileSync(
    testPath,
    `import assert from "node:assert/strict";
import test from "node:test";
import { currentRetentionDays, recommendRetentionPolicy } from "../src/retention.js";

test("current defaults remain stable", () => {
  assert.equal(currentRetentionDays("critical"), 30);
  assert.equal(currentRetentionDays("standard"), 7);
  assert.equal(recommendRetentionPolicy({ tier: "critical" }).days, 30);
  assert.equal(recommendRetentionPolicy({ tier: "standard" }).days, 7);
  for (const tier of ["unknown", undefined, null, 1, {}, [], true]) {
    assert.throws(() => recommendRetentionPolicy({ tier }), TypeError);
  }
  assert.throws(() => recommendRetentionPolicy(), TypeError);
});

test("a constrained storage budget lowers retention deterministically", () => {
  assert.equal(recommendRetentionPolicy({ tier: "critical", storageBudgetGb: 0.5 }).days, 15);
});

test("high event volume lowers retention deterministically", () => {
  assert.equal(recommendRetentionPolicy({ tier: "critical", eventVolume: 1_000_001 }).days, 15);
});

test("recommendations remain JSON-safe and within bounds", () => {
  const recommendation = recommendRetentionPolicy({ tier: "standard", eventVolume: 2_000_000, storageBudgetGb: 0 });
  assert.ok(recommendation.days >= 1 && recommendation.days <= 90);
  assert.equal(JSON.parse(JSON.stringify(recommendation)).days, recommendation.days);
});
`,
    { mode: 0o600 },
  );
  const markerPath = resolve(process.cwd(), ".mission-control-mock-implementation.txt");
  governedWriteFileSync(markerPath, `runtime-v6 mock implementation\nassignment=${context.assignmentId}\n`, {
    mode: 0o600,
  });
  const summary =
    "Bounded mock implementation created one reviewable local file; no authenticated provider was invoked.";
  if (outputPath) governedWriteFileSync(outputPath, summary, { mode: 0o600 });
  process.stdout.write(summary);
}
