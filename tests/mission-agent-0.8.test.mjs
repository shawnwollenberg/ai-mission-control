import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { canonicalHash } from "../lib/canonical-json.ts";

const run = promisify(execFile);
const script = resolve(process.env.MISSION_AGENT_080_TEST_ARTIFACT ?? "public/mission-agent-0.8.0.mjs");
const developmentTemplate = resolve("scripts/mission-agent-080.template.mjs");
const realAcceptanceHarness = resolve("scripts/run-consensus-real-acceptance.ts");

test("real consensus guidance distinguishes concrete blockers from optional notes and preserves failure evidence", async () => {
  const source = await readFile(developmentTemplate, "utf8");
  assert.match(source, /every released blocking objection is substantively resolved/);
  assert.match(source, /include every exact released blocker ID in resolved_objection_ids/);
  assert.match(source, /Never claim an objection is resolved without addressing it/);
  assert.match(source, /The canonical plan must substantively satisfy every acceptance criterion/);
  assert.match(source, /A blocking objection must identify a concrete unmet requirement or unsafe contradiction/);
  assert.match(source, /optional enhancements or stylistic preferences in non_blocking_notes/);
  const harness = await readFile(realAcceptanceHarness, "utf8");
  assert.match(harness, /artifact_kind='canonical_plan_verdict'/);
  assert.match(harness, /FROM consensus_objections WHERE workspace_id=\$1/);
  assert.match(harness, /verdictEvidence, objectionEvidence/);
});

test("structured provider authentication failures are terminal without content-based false positives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-agent-provider-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requirements = await readFile(resolve("domain/provider-runtime-requirements.json"), "utf8");
  const profiles = await readFile(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8");
  const candidate = join(root, "candidate.mjs");
  const source = (await readFile(developmentTemplate, "utf8"))
    .replace("__MISSION_AGENT_BUILD_SOURCE_COMMIT__", "33d4bcd62789f767a7bbe9b1f7588eee4f0f0549")
    .replace("__MISSION_AGENT_ACCEPTANCE_SOURCE_MANIFEST_SHA256__", "a".repeat(64))
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_REQUIREMENTS__", requirements.trim())
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_PROFILES__", profiles.trim());
  await writeFile(candidate, source);
  const {
    failedProviderInitializationPhase,
    implementationProviderRetryable,
    structuredProviderAuthenticationFailure,
  } = await import(`${pathToFileURL(candidate).href}?provider-auth=${Date.now()}`);
  const expired = JSON.stringify({
    type: "result",
    is_error: true,
    terminal_reason: "api_error",
    api_error_status: 401,
    error_code: "oauth_token_expired",
    result: "Provider authentication is unavailable.",
  });
  assert.equal(structuredProviderAuthenticationFailure(expired, ""), true);
  assert.equal(
    structuredProviderAuthenticationFailure(
      JSON.stringify({ type: "result", is_error: false, result: "The application documentation mentions HTTP 401." }),
      "",
    ),
    false,
  );
  assert.equal(structuredProviderAuthenticationFailure("unstructured 401 authentication text", ""), false);
  assert.equal(failedProviderInitializationPhase(expired, ""), "provider_authentication");
  assert.equal(
    failedProviderInitializationPhase("transient crash while rendering authentication documentation", ""),
    "provider_process",
  );
  assert.equal(
    implementationProviderRetryable({
      cancellationRequested: false,
      timedOut: false,
      failedInitializationPhase: "provider_authentication",
      exitCode: 1,
      terminationSignal: null,
    }),
    false,
  );
  assert.equal(
    implementationProviderRetryable({
      cancellationRequested: false,
      timedOut: false,
      failedInitializationPhase: "provider_process",
      exitCode: 1,
      terminationSignal: null,
    }),
    true,
  );

  assert.match(source, /!implementationProviderRetryable\(lastProviderDiagnostic\)/);
  assert.match(source, /authenticationFailure \? "provider_authentication_failure" : "local_adapter_failure"/);
});

test("development provider diagnostics bind attempts and never transmit environment values", async () => {
  const source = await readFile(developmentTemplate, "utf8");
  assert.match(source, /schemaVersion: "provider-runtime-diagnostic\/1"/);
  assert.match(source, /providerAttemptId: `\$\{assignment\.attempt\}-\$\{providerAttempt\}`/);
  assert.match(source, /stdoutHash: sha256\(stdout\)/);
  assert.match(source, /stderrHash: sha256\(stderr\)/);
  assert.match(source, /environmentVariableNames: Object\.keys\(launch\.env\)\.sort\(\)/);
  assert.doesNotMatch(source, /environmentVariables: launch\.env/);
  assert.match(source, /error\.providerDiagnostic = diagnostics\.at\(-1\)/);
  assert.match(source, /error\.providerDiagnostics = diagnostics/);
  assert.match(source, /const providerDiagnosticHistories = new WeakMap\(\)/);
  assert.match(source, /const retryLimit = implementationProviderRetryLimit\(assignment\)/);
  assert.match(source, /providerAttempt <= retryLimit \+ 1/);
  assert.match(source, /replacementProviderAttemptId/);
  assert.match(source, /"provider_retry_authorized"/);
  assert.match(source, /exec\("git", \["reset", "--hard", baseCommit\]/);
  assert.match(source, /exec\("git", \["clean", "-fdx"\]/);
  assert.match(source, /"semantic_validation_rejection"/);
  assert.doesNotMatch(source, /previous execution produced no repository changes/i);
  assert.doesNotMatch(source, /providerAttempt: 1,/);
  assert.match(source, /"ExecutionFailed", \{[\s\S]*providerDiagnostic/);
  assert.match(source, /"ExecutionCancellationAcknowledged", \{[\s\S]*providerDiagnostic/);

  const acceptance = await readFile(realAcceptanceHarness, "utf8");
  assert.match(acceptance, /approvedPacket\.rollbackSha256/);
  assert.match(acceptance, /approvedPacket\.repositoryAuthorityMigrationSha256/);
  assert.match(acceptance, /approvedPacket\.repositoryAuthorityRollbackSha256/);
  assert.match(acceptance, /approvedPacket\.artifactFixtureSha256/);
  assert.match(acceptance, /assertDisposableAcceptanceHarnessSafety/);
  assert.match(acceptance, /disposableArtifactApproval\("0\.8\.0"\)/);
  assert.deepEqual(acceptance.match(/CONSENSUS_ACCEPTANCE_[A-Z_]+SHA256/g), [
    "CONSENSUS_ACCEPTANCE_INFRASTRUCTURE_INVENTORY_SHA256",
  ]);
  assert.match(acceptance, /credentialFreeArtifactPreflight/);
  assert.match(acceptance, /lifecycleReport/);
  assert.match(acceptance, /changedModelAssignment/);
  assert.match(acceptance, /\["']leaseToken\["']\\s\*:/);
  assert.match(acceptance, /process\.env\.APP_ENV !== "disposable_acceptance"/);
  assert.match(acceptance, /ACCEPTANCE_SETUP_FAILURE/);
  assert.match(acceptance, /runDisposableAcceptancePreflight/);
  assert.match(acceptance, /changedModelError instanceof ApplicationError/);
  assert.match(acceptance, /eligibilityCode: "disposable_model_assignment_mismatch"/);
  assert.match(acceptance, /assert\.deepEqual\(changedModelAfter, changedModelBefore\)/);
  assert.doesNotMatch(acceptance, /assert\.rejects\([\s\S]{0,300}model/i);

  const remoteMessages = await readFile(resolve("application/remote-agent-messages.ts"), "utf8");
  const diagnosticDomain = await readFile(resolve("domain/provider-runtime-diagnostic.ts"), "utf8");
  assert.match(diagnosticDomain, /maximumProviderRuntimeDiagnosticHistory = 11/);
  assert.equal((remoteMessages.match(/values\.length > maximumProviderRuntimeDiagnosticHistory/g) ?? []).length, 1);
  assert.equal(
    (remoteMessages.match(/diagnostics\.length > maximumProviderRuntimeDiagnosticHistory/g) ?? []).length,
    1,
  );
});

test("development runtime profiles isolate provider credentials and enforce outer implementation authority", async () => {
  const source = await readFile(developmentTemplate, "utf8");
  const profiles = JSON.parse(await readFile(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8"));
  assert.deepEqual(Object.keys(profiles.profiles).sort(), [
    "claude-implementation-macos-v2",
    "claude-planning-macos-v2",
    "codex-implementation-macos-v2",
    "codex-planning-macos-v2",
  ]);
  assert.match(source, /function claudeKeychainReference/);
  assert.match(source, /"find-generic-password",[\s\S]*keychain\.service,[\s\S]*"-a",[\s\S]*keychain\.account/);
  assert.match(source, /env\.CLAUDE_CODE_OAUTH_TOKEN = accessToken/);
  assert.match(source, /await symlink\(sourceCodexAuth/);
  assert.doesNotMatch(source, /copyFile\(sourceAuth/);
  assert.doesNotMatch(source, /join\(realHome, "\.claude"\)/);
  assert.doesNotMatch(source, /Library\/Keychains/);
  assert.match(source, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(source, /"implementation"/);
  assert.match(profiles.sandboxPolicyTemplate, /\(deny network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.match(source, /complete_repository_state\/3/);
  assert.match(source, /trackedContentMatchesIndex/);
  assert.match(source, /runtimeBindingHash/);
  assert.match(source, /verifiedProviderExecutable/);
  assert.match(source, /invokedExecutableSha256/);
  assert.match(source, /spawnSync\(verifiedExecutable\.invokedExecutable/);
  assert.match(source, /const providerRootRelative = relative\(lexicalMissionAgentRoot, lexicalProviderRoot\)/);
  assert.match(source, /metadata\.isSymbolicLink\(\) \|\| !metadata\.isDirectory\(\)/);
  assert.match(
    source,
    /const canonicalProviderRelative = relative\(canonicalMissionAgentRoot, canonicalProviderRoot\)/,
  );
  assert.match(source, /Provider private runtime root escapes Mission Agent authority/);
  assert.match(source, /env\.CLAUDE_CODE_TMPDIR = canonicalProviderRoot/);
  assert.match(source, /relevantIgnoredManifestHash/);
  assert.equal(profiles.profiles["codex-planning-macos-v2"].providerInvocation.mode, "direct_native_binary");
  assert.match(
    profiles.profiles["codex-planning-macos-v2"].approvedRuntimeBinding.invokedExecutableSha256,
    /^[a-f0-9]{64}$/,
  );
});

test("complete repository state detects tracked bytes hidden by skip-worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "mission-agent-complete-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "README.md"), "# Bound\n");
  await run("git", ["init", "-b", "main"], { cwd: repository });
  await run("git", ["remote", "add", "origin", "https://github.com/example/repository.git"], {
    cwd: repository,
  });
  await run("git", ["add", "README.md"], { cwd: repository });
  await run("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", "commit", "-m", "base"], {
    cwd: repository,
  });
  await run("git", ["update-index", "--skip-worktree", "README.md"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Hidden local bytes\n");
  assert.equal((await run("git", ["status", "--porcelain"], { cwd: repository })).stdout, "");
  const requirements = await readFile(resolve("domain/provider-runtime-requirements.json"), "utf8");
  const profiles = await readFile(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8");
  const candidate = join(root, "candidate.mjs");
  const source = (await readFile(developmentTemplate, "utf8"))
    .replace("__MISSION_AGENT_BUILD_SOURCE_COMMIT__", "33d4bcd62789f767a7bbe9b1f7588eee4f0f0549")
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_REQUIREMENTS__", requirements.trim())
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_PROFILES__", profiles.trim());
  await writeFile(candidate, source);
  const { completeRepositoryState, durableStateValue, providerRuntimeProfileBinding } = await import(
    `${pathToFileURL(candidate).href}?state=${Date.now()}`
  );
  const rawLeaseToken = `mc_lease_${"local-state-secret".repeat(3)}`;
  const durableLeaseState = durableStateValue({
    activeAssignment: {
      workspaceId: "33333333-3333-4333-8333-333333333333",
      agentId: "44444444-4444-4444-8444-444444444444",
      credentialId: "55555555-5555-4555-8555-555555555555",
      assignmentId: "11111111-1111-4111-8111-111111111111",
      executionId: "22222222-2222-4222-8222-222222222222",
      leaseOwner: "runtime",
      leaseToken: rawLeaseToken,
      leaseIssuedAt: "2026-08-04T12:00:00.000Z",
      leaseExpiresAt: "2026-08-04T12:01:00.000Z",
      fencingToken: 8,
    },
  });
  assert.equal(JSON.stringify(durableLeaseState).includes(rawLeaseToken), false);
  assert.equal("leaseToken" in durableLeaseState.activeAssignment, false);
  assert.match(durableLeaseState.activeAssignment.leaseAuthorizationReceipt.tokenFingerprint, /^[a-f0-9]{64}$/);
  assert.match(durableLeaseState.activeAssignment.leaseAuthorizationReceipt.leaseId, /^[0-9a-f-]{36}$/);
  assert.equal(durableLeaseState.activeAssignment.leaseAuthorizationReceipt.kind, "execution_assignment");
  assert.equal(
    durableLeaseState.activeAssignment.leaseAuthorizationReceipt.binding.credentialId,
    "55555555-5555-4555-8555-555555555555",
  );
  assert.equal(durableLeaseState.activeAssignment.leaseAuthorizationReceipt.fencingToken, 8);
  assert.throws(
    () =>
      durableStateValue({
        activeAssignment: {
          leaseAuthorizationReceipt: {
            ...durableLeaseState.activeAssignment.leaseAuthorizationReceipt,
            AccessToken: "forbidden",
          },
        },
      }),
    /invalid schema/,
  );
  const state = await completeRepositoryState(repository);
  assert.equal(state.schemaVersion, "complete_repository_state/3");
  assert.equal(state.baseBranch, "main");
  assert.equal(state.trackedManifest.length, 1);
  assert.equal(state.trackedManifest[0].path, "README.md");
  assert.equal(state.trackedManifest[0].mode, "100644");
  assert.equal(state.trackedStatusEmpty, true);
  assert.equal(state.trackedContentMatchesIndex, false);
  const fakeBin = join(root, "fake-bin");
  const executedMarker = join(root, "untrusted-provider-executed");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "codex"),
    `#!/bin/sh\nprintf unsafe > ${JSON.stringify(executedMarker)}\necho 'codex-cli 0.146.0'\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${originalPath}`;
  try {
    assert.throws(() => providerRuntimeProfileBinding("codex-planning-macos-v2"), /not approved/);
    await assert.rejects(readFile(executedMarker), /ENOENT/);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("provider runtime requirements are embedded, provider-specific, and fail closed", async () => {
  const source = await readFile(script, "utf8");
  const capabilities = JSON.parse(await readFile(`${script}.capabilities.json`, "utf8"));
  assert.equal(capabilities.providerRuntimeRequirements.contractVersion, "provider-runtime-requirements/1");
  assert.equal(capabilities.providerRuntimeRequirements.providers.codex.modelSelection.argument, "--model");
  assert.equal(capabilities.providerRuntimeRequirements.providers.claude_code.modelSelection.argument, "--model");
  assert.equal(capabilities.providerRuntimeRequirements.providers.codex.modelSelection.fallback, "disabled");
  assert.equal(capabilities.providerRuntimeRequirements.providers.claude_code.modelSelection.fallback, "disabled");
  assert.deepEqual(capabilities.repositoryAuthority, {
    profile: "disposable_local_implementation/1",
    repositoryReadAllowed: true,
    isolatedWorktreeWriteAllowed: true,
    missionAgentLocalCommitAllowed: true,
    providerDirectCommitAllowed: false,
    pushAllowed: false,
    pullRequestAllowed: false,
    mergeAllowed: false,
    publicationAllowed: false,
    deploymentAllowed: false,
    infrastructureMutationAllowed: false,
    binding: "authenticated_owner_command_event_and_immutable_receipt",
    revalidation: [
      "mission_creation",
      "planner_dispatch_claim_renewal",
      "human_approval",
      "child_creation",
      "executor_dispatch_claim_renewal",
      "before_mutation",
      "before_local_commit",
      "terminal_success",
    ],
  });
  assert.match(source, /providerRuntimeStatus: providerRuntimeStatus\(config\)/);
  assert.match(source, /spawnSync\(\s*verifiedExecutable\.invokedExecutable,\s*requirement\.authenticationProbe/);
  assert.match(source, /requires an exact assigned model; fallback is disabled/);
  assert.match(source, /requirement\.modelSelection\.fallback !== "disabled"/);
  const sandboxPolicy = capabilities.providerRuntimeProfiles.sandboxPolicyTemplate;
  assert.match(sandboxPolicy, /\(allow network-outbound/);
  assert.match(sandboxPolicy, /\(deny network-outbound \(remote ip "localhost:\*"\)\)/);
  assert.doesNotMatch(sandboxPolicy, /\(allow network\*\)/);
  assert.doesNotMatch(sandboxPolicy, /\(allow network-bind/);
  assert.doesNotMatch(sandboxPolicy, /\(allow network-inbound/);
  assert.match(source, /env\.CLAUDE_CODE_OAUTH_TOKEN = accessToken/);
  assert.doesNotMatch(source, /Library\/Keychains/);
  assert.match(source, /Consensus planning requires a clean, content-addressed registered repository snapshot/);
  assert.match(source, /Implementation repository state drifted from the approved consensus snapshot/);
  assert.match(source, /const providerDeadline = Date\.now\(\)/);
  assert.match(source, /const remainingProviderMs = providerDeadline - Date\.now\(\)/);
  assert.match(source, /redacted-private-material/);
  assert.match(source, /redacted-mission-control-secret/);
  assert.match(source, /redacted-credential-url/);
  const analysisPath = source.match(/async function executeAnalysis[\s\S]*?async function uploadArtifact/)?.[0] ?? "";
  const consensusPath = source.match(/async function executeConsensus[\s\S]*?async function executeChange/)?.[0] ?? "";
  assert.doesNotMatch(analysisPath, /c\.baseBranch/);
  assert.match(consensusPath, /repository\.branch !== c\.baseBranch/);
  const developmentSource = await readFile(developmentTemplate, "utf8");
  assert.match(
    developmentSource,
    /validation_plan: safeValidationCommands\(assignment\.validationCommands \?\? \[\]\)\.map\(\(command\) => command\.join\(" "\)\)/,
  );
  assert.match(developmentSource, /properties\.validation_plan = \{/);
  assert.match(developmentSource, /minItems: 1/);
  assert.match(developmentSource, /items: \{ type: "string", enum: ownerGovernedValidationCommands \}/);
});

test("provider diagnostics redact JSON, environment, bearer, and private-key secrets", async () => {
  const source = await readFile(script, "utf8");
  const functionSource = source.match(
    /(function redactedProviderDiagnostic[\s\S]*?)\nfunction terminateProviderProcess/,
  )?.[1];
  assert.ok(functionSource);
  const redact = new Function(`${functionSource}; return redactedProviderDiagnostic;`)();
  for (const secret of [
    '{"password":"abcdefghijklmnop"}',
    '{"access_token":"token-value-abcdefghijkl"}',
    "CLIENT_SECRET=abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN PRIVATE KEY-----\nabcdefghijklmnop\n-----END PRIVATE KEY-----",
  ]) {
    const redacted = redact(secret);
    assert.doesNotMatch(redacted, /abcdefghijklmnop|abcdefghijklmnopqrstuvwxyz123456/);
    assert.match(redacted, /redacted/);
  }
});

test("long provider operations keep both agent health and execution leases current", async () => {
  const source = await readFile(developmentTemplate, "utf8");
  const leaseRenewals = source.match(
    /void assignmentAction\(\s*config,\s*assignment,\s*"lease",\s*"AgentAssignmentLeaseRenewed",?\s*\)\.catch/g,
  );
  assert.equal(leaseRenewals?.length, 2);
  assert.match(source, /async function runCodex[\s\S]*void heartbeat\(config\)[\s\S]*leaseAuthorityFailure = error/);
  assert.match(
    source,
    /async function runClaudeChange[\s\S]*void executionHeartbeat\([\s\S]*leaseAuthorityFailure = error/,
  );
});

test("Codex and Claude provider paths enforce wall-clock termination, cancellation, and crash-safe review", async () => {
  const source = await readFile(script, "utf8");
  const developmentSource = await readFile(developmentTemplate, "utf8");
  assert.match(source, /function terminateProviderProcess[\s\S]*process\.kill\(-child\.pid/);
  assert.match(source, /async function runCodex[\s\S]*providerTimedOut = true[\s\S]*SIGKILL/);
  assert.match(source, /async function runClaudeChange[\s\S]*providerTimedOut = true[\s\S]*SIGKILL/);
  assert.match(developmentSource, /async function runClaudeChange[\s\S]*verifyProviderProcessTreeTerminated\(child\)/);
  const developmentCodexPath =
    developmentSource.match(/async function runCodex[\s\S]*?async function runStructuredProvider/)?.[0] ?? "";
  const developmentClaudePath =
    developmentSource.match(/async function runClaudeChange[\s\S]*?async function executeChange/)?.[0] ?? "";
  assert.doesNotMatch(developmentCodexPath, /rm\(launch\.temporaryDirectory/);
  assert.doesNotMatch(developmentClaudePath, /rm\(launch\.temporaryDirectory/);
  assert.match(developmentSource, /finally \{[\s\S]*rm\(join\(root, "provider-sandboxes", assignment\.executionId\)/);
  assert.match(source, /const changeProviderDeadline = Date\.now\(\)/);
  assert.match(source, /runClaudeChange\([\s\S]*changeProviderDeadline/);
  assert.match(source, /running_codex_retry[\s\S]*changeProviderDeadline/);
  assert.match(source, /ExecutionCancellationAcknowledged/);
  assert.match(source, /stage: "recovery_review_required"/);
  assert.doesNotMatch(
    source.match(/if \(recoveredCommit\)[\s\S]*?await progress\(config, assignment, "worktree_ready"/)?.[0] ?? "",
    /ExecutionSucceeded/,
  );
});

test("Claude planning uses a fenced read-only process and submits structured provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mission-agent-claude-"));
  const home = join(directory, "home");
  const repository = join(directory, "repository");
  const bin = join(directory, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(repository, { recursive: true });
  await mkdir(bin, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run("git", ["init", "-b", "main"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Fixture\n");
  await run("git", ["add", "README.md"], { cwd: repository });
  await run("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "fixture"], {
    cwd: repository,
  });
  await run("git", ["remote", "add", "origin", "https://github.com/example/repository.git"], {
    cwd: repository,
  });
  const commit = (await run("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
  const argsLog = join(directory, "claude-args.json");
  const missionId = "11111111-1111-4111-8111-111111111111";
  const assignmentId = "22222222-2222-4222-8222-222222222222";
  const participantId = "33333333-3333-4333-8333-333333333333";
  const { completeRepositoryState } = await import(`${pathToFileURL(script).href}?fixture=${Date.now()}`);
  const snapshot = (await completeRepositoryState(repository)).snapshotHash;
  const contextBody = Buffer.from("safe immutable context");
  const contextHash = createHash("sha256").update(contextBody).digest("hex");
  const output = {
    schema_version: "consensus-plan-proposal/1",
    mission_id: missionId,
    assignment_id: participantId,
    repository_snapshot: snapshot,
    context_pack_hash: contextHash,
    problem_definition: "Fixture",
    assumptions: [],
    proposed_approach: "Use existing boundaries",
    affected_components: [],
    data_model_changes: [],
    api_changes: [],
    migration_plan: [],
    implementation_steps: [],
    validation_plan: [],
    rollback_plan: [],
    security_considerations: [],
    operational_considerations: [],
    risks: [],
    open_questions: [],
    recommended_executor_capabilities: [],
    confidence: 0.9,
  };
  const fixtureOauthToken = "fixture-only-oauth-token-with-no-provider-authority";
  const fakeClaude = join(bin, "claude");
  const fakeClaudeSource = join(bin, "claude.c");
  await writeFile(
    fakeClaudeSource,
    `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc>1&&strcmp(argv[1],"auth")==0)return 0;if(argc>1&&strcmp(argv[1],"--version")==0){fputs("Claude Code 2.1.224\\n",stdout);return 0;}const char *token=getenv("CLAUDE_CODE_OAUTH_TOKEN");if(!token||strcmp(token,${JSON.stringify(fixtureOauthToken)})!=0)return 18;if(!getenv("CLAUDE_CODE_TMPDIR"))return 19;fputs(${JSON.stringify(JSON.stringify(output))},stdout);return 0;}\n`,
  );
  await run("/usr/bin/cc", [fakeClaudeSource, "-o", fakeClaude]);
  await chmod(fakeClaude, 0o700);
  const fixtureKeychain = join(directory, "fixture.keychain-db");
  const fixtureKeychainAccount = "fixture-claude-account";
  await writeFile(fixtureKeychain, "fixture-only keychain identity\n", { mode: 0o600 });
  const resolvedFixtureKeychain = await realpath(fixtureKeychain);
  const fakeSecurity = join(bin, "security");
  const fakeSecuritySource = join(bin, "security.c");
  await writeFile(
    fakeSecuritySource,
    `#include <stdio.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc>1&&strcmp(argv[1],"default-keychain")==0){fputs(${JSON.stringify(`${resolvedFixtureKeychain}\n`)},stdout);return 0;}for(int i=1;i<argc;i++){if(strcmp(argv[i],"-w")==0){fputs(${JSON.stringify(JSON.stringify({ claudeAiOauth: { accessToken: fixtureOauthToken } }))},stdout);return 0;}}fputs(${JSON.stringify(`"acct"<blob>="${fixtureKeychainAccount}"\n`)},stdout);return 0;}\n`,
  );
  await run("/usr/bin/cc", [fakeSecuritySource, "-o", fakeSecurity]);
  await chmod(fakeSecurity, 0o700);
  const resolvedFakeSecurity = await realpath(fakeSecurity);
  const fixtureScript = join(directory, "mission-agent-fixture.mjs");
  const requirements = await readFile(resolve("domain/provider-runtime-requirements.json"), "utf8");
  const acceptanceSourceManifest = JSON.parse(
    await readFile(resolve("domain/mission-control-acceptance-source-manifest.json"), "utf8"),
  );
  const acceptanceSourceManifestSha256 = canonicalHash(acceptanceSourceManifest);
  const fixtureProfiles = JSON.parse(await readFile(resolve("domain/provider-runtime-profiles.proposed.json"), "utf8"));
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const resolvedFakeClaude = await realpath(fakeClaude);
  const resolvedBin = await realpath(bin);
  for (const profileId of ["claude-planning-macos-v2", "claude-implementation-macos-v2"]) {
    const fixtureProfile = fixtureProfiles.profiles[profileId];
    fixtureProfile.providerInvocation = {
      mode: "direct_executable",
      relativeExecutableFromInstallationRoot: "claude",
    };
    fixtureProfile.approvedRuntimeBinding = {
      ...fixtureProfile.approvedRuntimeBinding,
      providerExecutableSha256: hash(await readFile(resolvedFakeClaude)),
      resolvedExecutableIdentitySha256: hash(resolvedFakeClaude),
      invokedExecutableSha256: hash(await readFile(resolvedFakeClaude)),
      invokedExecutableIdentitySha256: hash(resolvedFakeClaude),
      installationRootIdentitySha256: hash(resolvedBin),
      lexicalRuntimeRootIdentitySha256: hash(resolvedBin),
      agentRuntimeRootIdentitySha256: hash(resolve(dirname(process.execPath), "..")),
      keychainIdentitySha256: hash(resolvedFixtureKeychain),
      keychainAccountIdentitySha256: hash(fixtureKeychainAccount),
    };
  }
  const productionTemplateSource = await readFile(developmentTemplate, "utf8");
  assert.match(productionTemplateSource, /spawnSync\(\s*"\/usr\/bin\/security"/);
  const fixtureSource = productionTemplateSource
    .replace("__MISSION_AGENT_BUILD_SOURCE_COMMIT__", "33d4bcd62789f767a7bbe9b1f7588eee4f0f0549")
    .replace("__MISSION_AGENT_ACCEPTANCE_SOURCE_MANIFEST_SHA256__", acceptanceSourceManifestSha256)
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_REQUIREMENTS__", requirements.trim())
    .replace("__MISSION_AGENT_PROVIDER_RUNTIME_PROFILES__", JSON.stringify(fixtureProfiles))
    .replaceAll('"/usr/bin/security"', JSON.stringify(resolvedFakeSecurity));
  assert.doesNotMatch(fixtureSource, /"\/usr\/bin\/security"/);
  await writeFile(fixtureScript, fixtureSource, { mode: 0o700 });
  const fixtureArtifactSha256 = hash(fixtureSource);
  await writeFile(
    `${fixtureScript}.artifact.json`,
    JSON.stringify({
      artifactByteLength: Buffer.byteLength(fixtureSource),
      canonicalizationVersion: "release-manifest-json-v3",
      manifestVersion: "3",
      publicKeyFingerprint: "ed25519-spki-sha256:7943a55a297cd50faf0a5841d06bcd0046d84dab73cc83543ba4021520706e8b",
      releaseAuthorityVersion: "v2",
      sha256: fixtureArtifactSha256,
      signingKeyId: "mission-agent-release-2026-01",
      sourceCommit: "33d4bcd62789f767a7bbe9b1f7588eee4f0f0549",
      version: "0.8.0",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    `${fixtureScript}.capabilities.json`,
    JSON.stringify({
      manifestVersion: "mission-agent-capabilities/1",
      version: "0.8.0",
      artifactSha256: fixtureArtifactSha256,
      sourceCommit: "33d4bcd62789f767a7bbe9b1f7588eee4f0f0549",
      acceptanceSourceManifestSha256,
      providerRuntimeRequirementsSha256: canonicalHash(JSON.parse(requirements)),
      providerRuntimeProfilesSha256: canonicalHash(fixtureProfiles),
    }),
    { mode: 0o600 },
  );
  const received = [];
  let pulled = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body) received.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/agent-protocol/v1/assignments/pull" && !pulled) {
      pulled = true;
      response.end(
        JSON.stringify({
          assignment: {
            assignmentId,
            missionId,
            taskId: "44444444-4444-4444-8444-444444444444",
            executionId: "55555555-5555-4555-8555-555555555555",
            attempt: 1,
            leaseOwner: "test-owner",
            leaseToken: "test-lease",
            fencingToken: 7,
            leaseIssuedAt: new Date().toISOString(),
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            missionType: "consensus_plan",
            taskObjective: "proposal",
            instructions: "proposal",
            timeoutSeconds: 60,
            allowedResources: [
              { resourceType: "repository", resourceId: "66666666-6666-4666-8666-666666666666", permission: "read" },
            ],
            artifactRequirements: ["consensus_proposal"],
            consensus: {
              operation: "proposal",
              participantAssignmentId: participantId,
              participantRole: "planner_a",
              planningRound: 1,
              repositorySnapshot: snapshot,
              baseBranch: "main",
              repositoryBaseCommit: commit,
              contextPackHash: contextHash,
              contextPack: { contentBase64: contextBody.toString("base64") },
              planningSchemaVersion: "consensus-plan/1",
              selectedModel: "test-model",
              missionObjective: "Plan the fixture",
              acceptanceCriteria: ["Safe"],
              missionConstraints: ["Read only"],
              sourceArtifacts: [],
              limits: { maximumArtifactBytes: 131072, maximumCommandCount: 100, maximumRetryCount: 2 },
            },
          },
        }),
      );
    } else if (request.url?.includes("/acknowledge")) response.end(JSON.stringify({ status: "acknowledged" }));
    else if (received.at(-1)?.body?.messageType === "ExecutionArtifactSubmitted")
      response.end(JSON.stringify({ artifactId: "77777777-7777-4777-8777-777777777777" }));
    else response.end(JSON.stringify({}));
  });
  await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  t.after(() => server.close());
  const address = server.address();
  const config = {
    missionControlUrl: `http://127.0.0.1:${address.port}`,
    workspaceId: "88888888-8888-4888-8888-888888888888",
    workspaceName: "Fixture",
    agentId: "99999999-9999-4999-8999-999999999999",
    agentName: "Claude Fixture",
    credentialId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    secret: "mc_agent_test_secret",
    secretStorage: "file-0600",
    adapter: "claude-code",
    leaseOwner: "test-owner",
    capabilities: ["repository.read", "plan.generate", "artifact.create"],
    providerProfile: {
      provider: "claude_code",
      supportedOperations: ["generate_structured_plan"],
      supportedModels: ["test-model"],
      modelCapabilities: [
        {
          modelId: "test-model",
          displayName: "Test model",
          provider: "claude_code",
          supportedRoles: ["planner"],
          supportedOperations: ["generate_structured_plan"],
          structuredOutput: true,
          repositoryRead: true,
          repositoryMutation: false,
          planMode: true,
          runtimeModelIdentity: "unverifiable",
        },
      ],
      capabilityAttestationVersion: 1,
      capabilitySource: "operator_allowlist",
      projectBrainContext: true,
    },
    repositories: {
      "66666666-6666-4666-8666-666666666666": { path: await realpath(repository), branch: "main", name: "repository" },
    },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  await run(process.execPath, [await realpath(fixtureScript), "run", "--once"], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MISSION_AGENT_HOME: home },
    timeout: 30_000,
  });
  await assert.rejects(readFile(argsLog, "utf8"), /ENOENT/);
  const source = await readFile(script, "utf8");
  assert.match(source, /"--safe-mode",\s*"--tools",\s*""/);
  assert.match(source, /"--disallowedTools",\s*"Read,Grep,Glob,Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"/);
  assert.match(source, /"--strict-mcp-config"/);
  assert.match(source, /"--disable-slash-commands"/);
  assert.match(source, /"--no-chrome"/);
  assert.match(source, /\.\.\.providerModelArguments\(provider, model\)/);
  assert.equal((await run("git", ["status", "--porcelain"], { cwd: repository })).stdout, "");
  const artifact = received.find((item) => item.body.messageType === "ExecutionArtifactSubmitted");
  assert.ok(
    artifact,
    JSON.stringify(
      received.map((item) => item.body),
      null,
      2,
    ),
  );
  assert.equal(artifact.body.payload.artifactType, "consensus_proposal");
  assert.equal(artifact.headers["x-mc-fencing-token"], "7");
  assert.deepEqual(JSON.parse(Buffer.from(artifact.body.payload.contentBase64, "base64").toString("utf8")), output);
  assert.ok(received.some((item) => item.body.messageType === "ExecutionSucceeded"));
});

test("every provider generation verifies process-tree termination after close", async () => {
  const source = await readFile(developmentTemplate, "utf8");
  assert.equal((source.match(/const processTreeTerminationAttempted = true;/g) ?? []).length, 3);
  assert.equal(
    (source.match(/const processTreeTerminationVerified = await verifyProviderProcessTreeTerminated\(child\);/g) ?? [])
      .length,
    3,
  );
  assert.doesNotMatch(
    source,
    /const processTreeTerminationVerified = processTreeTerminationAttempted\s*\? await verifyProviderProcessTreeTerminated/,
  );
});
