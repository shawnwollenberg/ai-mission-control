import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for integration tests");
const { getDatabasePool, closeDatabasePool } = await import("../lib/database.ts");
const {
  confirmReplacementPackageClaim,
  consumeGovernedReplacementReceipt,
  createReplacementMutationIntent,
  establishAuthoritativeReplacementDrain,
  issueReplacementCredentialAndClaim,
  persistIssuedReplacementPackage,
  readReplacementRecoveryState,
  requireReplacementRollback,
} = await import("../application/replacement-bootstrap-governance.ts");
const { fixedConditionChecksum, fixedOperationChecksum, REPLACEMENT_PROVIDER } =
  await import("../application/replacement-bootstrap-state-machine.ts");
const {
  createReplacementAuthorizationPackage,
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_CLAIM_PATH,
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_DECISION_PATH,
  REPLACEMENT_FAILURE_PATH,
  REPLACEMENT_INTENT_PATH,
  REPLACEMENT_PACKAGE_VERSION,
  REPLACEMENT_RECEIPT_PATH,
  REPLACEMENT_STATUS_PATH,
} = await import("../integrations/mission-agent/replacement-authorization-package.ts");
const { authorizationChecksum, validateReplacementAuthorization } =
  await import("../integrations/mission-agent/replacement-bootstrap.ts");
const { canonicalJson } = await import("../integrations/mission-agent/release-authority.ts");
const { deriveSigningKey } = await import("../remote-agent/protocol.ts");
const { ensureGovernedReplacementSmoke, evaluateGovernedReplacementSmoke } =
  await import("../application/replacement-bootstrap-smoke.ts");
const { processRemoteMessage } = await import("../application/remote-agent-messages.ts");

let authorization = validateReplacementAuthorization(
  JSON.parse(await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8")),
);
const workspaceId = authorization.workspaceId;
const executionId = "33333333-3333-4333-8333-333333333333";
const missionId = randomUUID();
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let issued;
let signingKey;
let pkg;
let artifactRoot;

async function withClient(action) {
  const client = await getDatabasePool().connect();
  try {
    return await action(client);
  } finally {
    client.release();
  }
}

test.before(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), "replacement-smoke-artifacts-"));
  process.env.ARTIFACT_STORAGE_PROVIDER = "local";
  process.env.ARTIFACT_STORAGE_ROOT = artifactRoot;
  await getDatabasePool().query(
    `CREATE TABLE IF NOT EXISTS replacement_bootstrap_disposable_environment_guard(
      instance_identity text PRIMARY KEY,
      resource_fingerprint text NOT NULL
    )`,
  );
  await getDatabasePool().query(
    `INSERT INTO replacement_bootstrap_disposable_environment_guard(instance_identity,resource_fingerprint)
     VALUES('mission-control-disposable-replacement-bootstrap-v1',$1)
     ON CONFLICT(instance_identity) DO UPDATE SET resource_fingerprint=EXCLUDED.resource_fingerprint`,
    ["f".repeat(64)],
  );
  await getDatabasePool().query(
    "INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Replacement Governance Integration')",
    [workspaceId, `replacement-${workspaceId}`],
  );
  await getDatabasePool().query(
    `INSERT INTO agents(
      workspace_id,agent_id,name,adapter_type,capabilities,supported_domains,trust_level,status,
      delivery_mode,mission_agent_version
    ) VALUES($1,$2,'Disposable named canary','remote_http',$3::jsonb,$4::jsonb,'high','active','pull','0.6.8')`,
    [
      workspaceId,
      authorization.agentId,
      JSON.stringify(["repository-analysis"]),
      JSON.stringify(["release-governance"]),
    ],
  );
  await getDatabasePool().query(
    `UPDATE agents SET last_heartbeat_at=clock_timestamp(),pull_ready_at=clock_timestamp(),
      protocol_versions='["1.0"]'::jsonb
      WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, authorization.agentId],
  );
  await getDatabasePool().query(
    `INSERT INTO repositories(
      workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,
      location_mode,repository_fingerprint,read_allowed,write_allowed,identity_migration_status
    ) VALUES($1,$2,'replacement-smoke-repository',$3,'main',$4::jsonb,'mission_agent',$5,true,false,'not_required')`,
    [
      workspaceId,
      authorization.repositoryId,
      `mission-agent://${authorization.repositoryFingerprint}`,
      JSON.stringify([authorization.agentId]),
      authorization.repositoryFingerprint,
    ],
  );
  await getDatabasePool().query(
    `INSERT INTO agent_resource_permissions(
      workspace_id,agent_id,resource_type,resource_id,permissions
    ) VALUES($1,$2,'repository',$3,'["read"]'::jsonb)`,
    [workspaceId, authorization.agentId, authorization.repositoryId],
  );
  await getDatabasePool().query(
    `INSERT INTO repository_identities(
      workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
      selected_remote,created_at,verified_at,verification_source,migration_status
    ) VALUES($1,$2,'legacy-v1',$3,$4,'replacement-smoke-repository','origin',
      clock_timestamp(),clock_timestamp(),'disposable-integration','active')`,
    [
      workspaceId,
      authorization.repositoryId,
      authorization.repositoryFingerprint,
      `mission-agent://${authorization.repositoryFingerprint}`,
    ],
  );
  await getDatabasePool().query(
    `INSERT INTO approval_projections(
      workspace_id,approval_id,mission_id,aggregate_version,approval_type,requested_action,
      action_hash,risk_explanation,evidence,requested_by,status,decided_by,expires_at,created_at,decided_at
    ) VALUES($1,$2,$3,1,'replacement-bootstrap',$4::jsonb,$5,'reviewed',$6::jsonb,
      'replacement-owner','granted',$7,$8,$9,$9)`,
    [
      workspaceId,
      authorization.approvalId,
      missionId,
      JSON.stringify({ authorizationId: authorization.authorizationId }),
      authorizationChecksum(authorization),
      JSON.stringify(authorization.evidenceReferences),
      authorization.approvedBy,
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  await getDatabasePool().query(
    `INSERT INTO mission_agent_replacement_bootstraps(
      workspace_id,authorization_id,approval_id,agent_id,protocol_version,authorization_record,
      authorization_checksum,state,aggregate_version,execution_count,expires_at,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'approved',1,0,$8,$9,$9)`,
    [
      workspaceId,
      authorization.authorizationId,
      authorization.approvalId,
      authorization.agentId,
      authorization.protocolVersion,
      JSON.stringify(authorization),
      authorizationChecksum(authorization),
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  issued = await withClient((client) =>
    issueReplacementCredentialAndClaim({
      client,
      authorization,
      executionId,
      authenticatedApprover: authorization.approvedBy,
    }),
  );
  signingKey = deriveSigningKey(issued.secret);
  pkg = createReplacementAuthorizationPackage({
    credentialSigningKey: signingKey,
    unsigned: {
      packageVersion: REPLACEMENT_PACKAGE_VERSION,
      protocolVersion: authorization.protocolVersion,
      credentialProtocol: REPLACEMENT_CREDENTIAL_PROTOCOL,
      credentialId: issued.credentialId,
      missionControlInstanceIdentity: MISSION_CONTROL_INSTANCE_ID,
      claimPath: REPLACEMENT_CLAIM_PATH,
      intentPath: REPLACEMENT_INTENT_PATH,
      receiptPath: REPLACEMENT_RECEIPT_PATH,
      decisionPath: REPLACEMENT_DECISION_PATH,
      statusPath: REPLACEMENT_STATUS_PATH,
      failurePath: REPLACEMENT_FAILURE_PATH,
      executionId,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: authorization.approvedAt,
      expiresAt: authorization.expiresAt,
      maximumUseCount: 1,
      authorization,
      approval: {
        approvalId: authorization.approvalId,
        status: "granted",
        decidedBy: authorization.approvedBy,
        actionHash: authorizationChecksum(authorization),
        decidedAt: authorization.approvedAt,
        expiresAt: authorization.expiresAt,
      },
      authorizationFingerprint: authorizationChecksum(authorization),
      evidenceInstructions: {
        mode: "authenticated-receipt-api",
        localDirectory: authorization.evidenceDestination,
        receiptSequenceStartsAt: 1,
      },
    },
  });
  await withClient((client) => persistIssuedReplacementPackage({ client, pkg }));
});

test.after(async () => {
  for (const table of [
    "mission_agent_replacement_evidence",
    "mission_agent_replacement_receipts",
    "mission_agent_replacement_mutation_intents",
    "mission_agent_replacement_execution_claims",
    "mission_agent_replacement_credentials",
    "mission_agent_replacement_events",
    "events",
    "agent_protocol_receipts",
    "mission_agent_replacement_bootstraps",
    "agent_credentials",
    "approval_projections",
    "agent_resource_permissions",
    "repository_identities",
    "repositories",
    "agents",
  ])
    await getDatabasePool().query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
  await getDatabasePool().query("DELETE FROM workspaces WHERE id=$1", [workspaceId]);
  await closeDatabasePool();
  await rm(artifactRoot, { recursive: true, force: true });
});

function operationReceipt(operation, sequence, options = {}) {
  const requestNonce = randomBytes(24).toString("base64url");
  const result = {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    safeStdoutSummary: `${operation} passed`,
    safeStderrSummary: "",
    inspectedChecksums: {},
    changedChecksums: {},
  };
  const unsigned = {
    receiptVersion: "1",
    authorizationId: options.authorizationId ?? authorization.authorizationId,
    executionId: options.executionId ?? executionId,
    credentialId: options.credentialId ?? issued.credentialId,
    agentId: options.agentId ?? authorization.agentId,
    providerIdentifier: options.providerIdentifier ?? REPLACEMENT_PROVIDER,
    authorizationFingerprint: options.authorizationFingerprint ?? authorizationChecksum(authorization),
    claimGeneration: options.claimGeneration ?? 1,
    operationId: options.operationId ?? randomUUID(),
    operation,
    sequence,
    requestNonce,
    receiptNonce: randomBytes(24).toString("base64url"),
    operationChecksum: fixedOperationChecksum({
      operation,
      authorizationFingerprint: options.authorizationFingerprint ?? authorizationChecksum(authorization),
      executionId: options.executionId ?? executionId,
      claimGeneration: options.claimGeneration ?? 1,
    }),
    resultChecksum: options.resultChecksum ?? sha256(canonicalJson(result)),
    hostJournalChecksum: sha256(`journal:${operation}:${sequence}`),
    recovery: options.recovery ?? false,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    status: "succeeded",
    safeStdoutSummary: result.safeStdoutSummary,
    safeStderrSummary: "",
    inspectedChecksums: {},
    changedChecksums: {},
    observation: options.observation ?? null,
  };
  const bytes = canonicalJson(unsigned);
  return {
    ...unsigned,
    receiptChecksum: sha256(bytes),
    authentication: createHmac("sha256", signingKey).update(bytes).digest("hex"),
  };
}

async function consume(receipt, overrides = {}) {
  const bodyChecksum = sha256(canonicalJson(receipt));
  return withClient((client) =>
    consumeGovernedReplacementReceipt({
      client,
      workspaceId,
      requestNonce: receipt.requestNonce,
      requestMessageId: overrides.requestMessageId ?? randomUUID(),
      requestBodyChecksum: bodyChecksum,
      credentialId: overrides.credentialId ?? issued.credentialId,
      receipt,
    }),
  );
}

test("one durable claim owner consumes exact ordered receipts and rejects cross-credential use", async () => {
  const claimResult = await withClient((client) =>
    confirmReplacementPackageClaim({
      client,
      workspaceId,
      agentId: authorization.agentId,
      credentialId: issued.credentialId,
      requestMessageId: randomUUID(),
      requestNonce: randomBytes(24).toString("base64url"),
      requestBodyChecksum: "b".repeat(64),
      body: {
        authorizationId: authorization.authorizationId,
        executionId,
        packageChecksum: pkg.packageChecksum,
        nonce: pkg.nonce,
      },
    }),
  );
  assert.deepEqual(claimResult, { claimed: true, nextSequence: 1, claimGeneration: 1 });
  await getDatabasePool().query(
    "UPDATE agents SET last_heartbeat_at=clock_timestamp() WHERE workspace_id=$1 AND agent_id=$2",
    [workspaceId, authorization.agentId],
  );
  const drain = await withClient((client) =>
    establishAuthoritativeReplacementDrain({
      client,
      workspaceId,
      authorizationId: authorization.authorizationId,
      executionId,
      agentId: authorization.agentId,
      stabilizationMs: 1_000,
    }),
  );
  assert.match(drain.drainEvidenceChecksum, /^[a-f0-9]{64}$/);
  const first = operationReceipt("inspect_host", 1);
  await assert.rejects(() => consume(first, { credentialId: randomUUID() }), /ownership|invalid/i);
  const attacks = [
    operationReceipt("inspect_host", 2),
    operationReceipt("inspect_host", 1, { claimGeneration: 2 }),
    operationReceipt("inspect_host", 1, { executionId: randomUUID() }),
    operationReceipt("inspect_host", 1, { agentId: randomUUID() }),
    operationReceipt("inspect_host", 1, { providerIdentifier: "wrong-provider" }),
    operationReceipt("inspect_host", 1, { authorizationFingerprint: "f".repeat(64) }),
  ];
  for (const attack of attacks) {
    await assert.rejects(() => consume(attack), /ownership|invalid|sequence|state|scope/i);
    const unchanged = (
      await getDatabasePool().query(
        `SELECT c.last_accepted_sequence,
                (SELECT count(*)::int FROM mission_agent_replacement_receipts r
                  WHERE r.workspace_id=c.workspace_id AND r.authorization_id=c.authorization_id
                    AND r.execution_id=c.execution_id) receipt_count
           FROM mission_agent_replacement_execution_claims c
          WHERE c.workspace_id=$1 AND c.authorization_id=$2 AND c.execution_id=$3`,
        [workspaceId, authorization.authorizationId, executionId],
      )
    ).rows[0];
    assert.deepEqual(unchanged, { last_accepted_sequence: 0, receipt_count: 0 });
  }
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_execution_claims SET expires_at=clock_timestamp()-interval '1 second'
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
    [workspaceId, authorization.authorizationId, executionId],
  );
  await assert.rejects(() => consume(first), /expired|ownership|invalid/i);
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_execution_claims SET expires_at=$4
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
    [workspaceId, authorization.authorizationId, executionId, authorization.expiresAt],
  );
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_credentials SET revoked_at=clock_timestamp()
      WHERE workspace_id=$1 AND credential_id=$2`,
    [workspaceId, issued.credentialId],
  );
  await assert.rejects(() => consume(first), /revoked|ownership|invalid/i);
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_credentials SET revoked_at=NULL
      WHERE workspace_id=$1 AND credential_id=$2`,
    [workspaceId, issued.credentialId],
  );
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_credentials SET maximum_receipt_sequence=999
      WHERE workspace_id=$1 AND credential_id=$2`,
    [workspaceId, issued.credentialId],
  );
  await assert.rejects(() => consume(first), /scope/i);
  await getDatabasePool().query(
    `UPDATE mission_agent_replacement_credentials SET maximum_receipt_sequence=$3
      WHERE workspace_id=$1 AND credential_id=$2`,
    [
      workspaceId,
      issued.credentialId,
      (await import("../application/replacement-bootstrap-state-machine.ts")).replacementForwardOperations.length +
        (await import("../application/replacement-bootstrap-state-machine.ts")).replacementRollbackOperations.length,
    ],
  );
  assert.deepEqual(await consume(first), {
    accepted: true,
    nextSequence: 2,
    state: "ready:inspect_agent",
  });
  await assert.rejects(() => consume(first), /terminal|invalid|duplicate|ownership/i);
  await assert.rejects(
    () => consume(operationReceipt("inspect_host", 1, { operationId: randomUUID() })),
    /terminal|invalid|duplicate|ownership|sequence|state/i,
  );
});

test("a mutation cannot execute without its exact committed intent and recovered receipt is accepted once", async () => {
  for (const [index, operation] of [
    "inspect_agent",
    "inventory_configuration",
    "verify_rollback_assets",
    "stage_node_archive",
    "verify_node_archive",
  ].entries())
    await consume(operationReceipt(operation, index + 2));
  const operation = "extract_node_runtime";
  const sequence = 7;
  const operationId = randomUUID();
  const postcondition = fixedConditionChecksum({
    operation,
    condition: "postcondition",
    authorizationFingerprint: authorizationChecksum(authorization),
  });
  const receipt = operationReceipt(operation, sequence, {
    operationId,
    resultChecksum: postcondition,
    recovery: true,
  });
  await assert.rejects(() => consume(receipt), /intent/i);
  const intentBinding = {
    requestMessageId: randomUUID(),
    requestNonce: randomBytes(24).toString("base64url"),
    requestBodyChecksum: sha256(canonicalJson({ operationId, operation, sequence })),
  };
  await assert.rejects(
    () =>
      withClient((client) =>
        createReplacementMutationIntent({
          client,
          workspaceId,
          authenticatedCredentialId: issued.credentialId,
          authenticatedAgentId: authorization.agentId,
          binding: {
            requestMessageId: randomUUID(),
            requestNonce: randomBytes(24).toString("base64url"),
            requestBodyChecksum: sha256("wrong-condition"),
          },
          request: {
            authorizationId: authorization.authorizationId,
            executionId,
            credentialId: issued.credentialId,
            agentId: authorization.agentId,
            providerIdentifier: REPLACEMENT_PROVIDER,
            authorizationFingerprint: authorizationChecksum(authorization),
            claimGeneration: 1,
            operationId: randomUUID(),
            operation,
            sequence,
            fixedArgumentsChecksum: fixedOperationChecksum({
              operation,
              authorizationFingerprint: authorizationChecksum(authorization),
              executionId,
              claimGeneration: 1,
            }),
            expectedPreconditionChecksum: "a".repeat(64),
            expectedPostconditionChecksum: "b".repeat(64),
          },
        }),
      ),
    /exact next authorized/i,
  );
  const intentRequest = {
    authorizationId: authorization.authorizationId,
    executionId,
    credentialId: issued.credentialId,
    agentId: authorization.agentId,
    providerIdentifier: REPLACEMENT_PROVIDER,
    authorizationFingerprint: authorizationChecksum(authorization),
    claimGeneration: 1,
    operationId,
    operation,
    sequence,
    fixedArgumentsChecksum: fixedOperationChecksum({
      operation,
      authorizationFingerprint: authorizationChecksum(authorization),
      executionId,
      claimGeneration: 1,
    }),
    expectedPreconditionChecksum: fixedConditionChecksum({
      operation,
      condition: "precondition",
      authorizationFingerprint: authorizationChecksum(authorization),
    }),
    expectedPostconditionChecksum: postcondition,
  };
  await assert.rejects(
    () =>
      withClient((client) =>
        createReplacementMutationIntent({
          client,
          workspaceId,
          authenticatedCredentialId: randomUUID(),
          authenticatedAgentId: authorization.agentId,
          binding: {
            requestMessageId: randomUUID(),
            requestNonce: randomBytes(24).toString("base64url"),
            requestBodyChecksum: sha256("independently-authenticated-other-credential"),
          },
          request: intentRequest,
        }),
      ),
    /credential binding/i,
  );
  const intent = await withClient((client) =>
    createReplacementMutationIntent({
      client,
      workspaceId,
      authenticatedCredentialId: issued.credentialId,
      authenticatedAgentId: authorization.agentId,
      binding: intentBinding,
      request: intentRequest,
    }),
  );
  assert.match(intent.intentChecksum, /^[a-f0-9]{64}$/);
  await assert.rejects(
    () =>
      withClient((client) =>
        createReplacementMutationIntent({
          client,
          workspaceId,
          authenticatedCredentialId: issued.credentialId,
          authenticatedAgentId: authorization.agentId,
          binding: intentBinding,
          request: intentRequest,
        }),
      ),
    /duplicate|unique|intent|replay/i,
  );
  assert.equal((await consume(receipt)).state, "ready:verify_node_executable");
  const recovery = await withClient((client) =>
    readReplacementRecoveryState({
      client,
      workspaceId,
      agentId: authorization.agentId,
      credentialId: issued.credentialId,
      authorizationId: authorization.authorizationId,
      executionId,
      authorizationFingerprint: authorizationChecksum(authorization),
      claimGeneration: 1,
      binding: {
        requestMessageId: randomUUID(),
        requestNonce: randomBytes(24).toString("base64url"),
        requestBodyChecksum: sha256(canonicalJson({ type: "recovery-status" })),
      },
    }),
  );
  assert.equal(recovery.lastAcceptedSequence, sequence);
  assert.equal(recovery.lastAcceptedOperation, operation);
  assert.equal(recovery.pendingIntent, null);
});

test("Mission Control creates and accepts only the immutable governed smoke records", async () => {
  let processStartedAt = new Date().toISOString();
  const processObservation = () => ({
    observationVersion: "mission-agent-process-v1",
    hostIdentity: authorization.hostIdentity,
    agentId: authorization.agentId,
    serviceLabel: "com.wallyweb.mission-agent",
    pid: 42420,
    parentPid: 1,
    processStartedAt,
    processOwner: "shawnwollenberg",
    nodeExecutable: authorization.nodeRuntime.executablePath,
    nodeVersion: `v${authorization.nodeRuntime.version}`,
    artifactPath: "/Users/shawnwollenberg/.mission-agent/mission-agent-0.7.2.mjs",
    artifactChecksum: authorization.targetArtifactSha256,
    processArgumentsChecksum: sha256(
      `${authorization.nodeRuntime.executablePath} /Users/shawnwollenberg/.mission-agent/mission-agent-0.7.2.mjs run`,
    ),
    launchdPlistChecksum: authorization.serviceReplacement.targetDefinitionSha256,
  });
  const forwardRemainder = [
    "verify_node_executable",
    "stage_target_artifact",
    "verify_release",
    "stage_target_plist",
    "verify_target_plist",
    "drain_agent",
    "stop_service",
    "replace_artifact",
    "replace_plist",
    "start_service",
    "verify_runtime",
    "verify_version",
    "verify_identity",
    "verify_registration",
  ];
  let sequence = 8;
  for (const operation of forwardRemainder) {
    const mutating = ["stop_service", "replace_artifact", "replace_plist", "start_service"].includes(operation);
    const operationId = randomUUID();
    const postcondition = fixedConditionChecksum({
      operation,
      condition: "postcondition",
      authorizationFingerprint: authorizationChecksum(authorization),
    });
    if (mutating)
      await withClient((client) =>
        createReplacementMutationIntent({
          client,
          workspaceId,
          authenticatedCredentialId: issued.credentialId,
          authenticatedAgentId: authorization.agentId,
          binding: {
            requestMessageId: randomUUID(),
            requestNonce: randomBytes(24).toString("base64url"),
            requestBodyChecksum: sha256(`${operation}:${sequence}`),
          },
          request: {
            authorizationId: authorization.authorizationId,
            executionId,
            credentialId: issued.credentialId,
            agentId: authorization.agentId,
            providerIdentifier: REPLACEMENT_PROVIDER,
            authorizationFingerprint: authorizationChecksum(authorization),
            claimGeneration: 1,
            operationId,
            operation,
            sequence,
            fixedArgumentsChecksum: fixedOperationChecksum({
              operation,
              authorizationFingerprint: authorizationChecksum(authorization),
              executionId,
              claimGeneration: 1,
            }),
            expectedPreconditionChecksum: fixedConditionChecksum({
              operation,
              condition: "precondition",
              authorizationFingerprint: authorizationChecksum(authorization),
            }),
            expectedPostconditionChecksum: postcondition,
          },
        }),
      );
    if (operation === "verify_runtime") processStartedAt = new Date(Date.now() + 5).toISOString();
    await consume(
      operationReceipt(operation, sequence, {
        operationId,
        ...(mutating ? { resultChecksum: postcondition } : {}),
        ...(["verify_runtime", "verify_version"].includes(operation) ? { observation: processObservation() } : {}),
      }),
    );
    sequence += 1;
  }
  const credential = {
    workspace_id: workspaceId,
    agent_id: authorization.agentId,
    credential_id: issued.credentialId,
    credential_record_status: "active",
  };
  for (let heartbeat = 0; heartbeat < 3; heartbeat += 1)
    await processRemoteMessage(
      {
        protocolVersion: "1.0",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        agentId: authorization.agentId,
        workspaceId,
        sentAt: new Date(Date.parse(processStartedAt) + 50 + heartbeat).toISOString(),
        messageType: "AgentHeartbeat",
        correlationId: executionId,
        attempt: 1,
        payload: {
          assignmentPull: true,
          missionAgentVersion: "0.7.2",
          adapter: "codex",
          artifact: {
            sha256: authorization.targetArtifactSha256,
            manifestVersion: "3",
            releaseAuthorityVersion: "v2",
            canonicalizationVersion: "release-manifest-json-v3",
          },
          release: {
            authorityVersion: "v2",
            manifestVersion: "3",
            canonicalizationVersion: "release-manifest-json-v3",
            signingKeyId: "mission-agent-release-2026-01",
            sourceCommit: "31b45c98f2ffba613b56cd23819ba8b0c9c09a43",
          },
          repositoryIdentity: {
            stableProtocolVersion: "2",
            activationAcknowledgementVersion: "1",
            repositories: [
              {
                repositoryId: authorization.repositoryId,
                fingerprint: authorization.repositoryFingerprint,
              },
            ],
          },
          projectBrain: {
            installed: true,
            runtimeReady: true,
            coreVersion: "0.4.0",
            contractVersions: ["1.0"],
            schemaVersions: ["2.5.0"],
            operations: ["detect_repository"],
            readOperations: ["detect_repository"],
            writeOperations: [],
            diagnosticsStatus: "ready",
            maxRequestBytes: 1024,
            maxResultBytes: 1024,
            artifactTransferModes: ["inline_base64"],
          },
        },
      },
      credential,
    );
  await consume(operationReceipt("verify_heartbeats", sequence++));
  await consume(
    operationReceipt("verify_capabilities", sequence++, {
      observation: processObservation(),
    }),
  );
  const smoke = await ensureGovernedReplacementSmoke({
    workspaceId,
    authorizationId: authorization.authorizationId,
    replacementExecutionId: executionId,
  });
  const execution = (
    await getDatabasePool().query(
      `SELECT mission_id,task_id FROM execution_projections
        WHERE workspace_id=$1 AND execution_id=$2`,
      [workspaceId, smoke.executionId],
    )
  ).rows[0];
  const envelope = (messageType, payload = {}) => ({
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: authorization.agentId,
    workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: smoke.executionId,
    missionId: execution.mission_id,
    taskId: execution.task_id,
    executionId: smoke.executionId,
    attempt: 1,
    payload,
  });
  await processRemoteMessage(envelope("ExecutionAccepted", { summary: "accepted" }), credential);
  await processRemoteMessage(
    envelope("ExecutionHeartbeat", {
      workerId: "replacement-smoke-worker",
      stage: "repository-analysis",
      summary: "read-only analysis",
      progressPercent: 50,
    }),
    credential,
  );
  const artifactBody = Buffer.from(JSON.stringify({ readOnly: true, templateChecksum: smoke.templateChecksum }));
  await processRemoteMessage(
    envelope("ExecutionArtifactSubmitted", {
      artifactType: "repository_analysis",
      mediaType: "application/json",
      contentBase64: artifactBody.toString("base64"),
      checksum: sha256(artifactBody),
      name: "replacement smoke evidence",
    }),
    credential,
  );
  await processRemoteMessage(envelope("ExecutionSucceeded", { summary: "read-only smoke complete" }), credential);
  const accepted = await evaluateGovernedReplacementSmoke({
    workspaceId,
    authorizationId: authorization.authorizationId,
    replacementExecutionId: executionId,
  });
  assert.equal(accepted.decision, "continue");
  assert.equal(accepted.missionId, smoke.missionId);
  assert.match(accepted.smokeEvidenceChecksum, /^[a-f0-9]{64}$/);
  const terminal = await consume(operationReceipt("report_evidence", sequence));
  assert.equal(terminal.state, "completed");
  const claim = await getDatabasePool().query(
    `SELECT state,completed_at FROM mission_agent_replacement_execution_claims
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
    [workspaceId, authorization.authorizationId, executionId],
  );
  assert.equal(claim.rows[0].state, "completed");
  assert.ok(claim.rows[0].completed_at);
});

test("a post-start failure restores exact 0.6.8 evidence and terminates the credential", async () => {
  authorization = validateReplacementAuthorization({
    ...authorization,
    authorizationId: randomUUID(),
    approvalId: randomUUID(),
  });
  const rollbackExecutionId = randomUUID();
  const rollbackMissionId = randomUUID();
  await getDatabasePool().query(
    `INSERT INTO approval_projections(
      workspace_id,approval_id,mission_id,aggregate_version,approval_type,requested_action,
      action_hash,risk_explanation,evidence,requested_by,status,decided_by,expires_at,created_at,decided_at
    ) VALUES($1,$2,$3,1,'replacement-bootstrap',$4::jsonb,$5,'reviewed',$6::jsonb,
      'replacement-owner','granted',$7,$8,$9,$9)`,
    [
      workspaceId,
      authorization.approvalId,
      rollbackMissionId,
      JSON.stringify({ authorizationId: authorization.authorizationId }),
      authorizationChecksum(authorization),
      JSON.stringify(authorization.evidenceReferences),
      authorization.approvedBy,
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  await getDatabasePool().query(
    `INSERT INTO mission_agent_replacement_bootstraps(
      workspace_id,authorization_id,approval_id,agent_id,protocol_version,authorization_record,
      authorization_checksum,state,aggregate_version,execution_count,expires_at,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'approved',1,0,$8,$9,$9)`,
    [
      workspaceId,
      authorization.authorizationId,
      authorization.approvalId,
      authorization.agentId,
      authorization.protocolVersion,
      JSON.stringify(authorization),
      authorizationChecksum(authorization),
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  issued = await withClient((client) =>
    issueReplacementCredentialAndClaim({
      client,
      authorization,
      executionId: rollbackExecutionId,
      authenticatedApprover: authorization.approvedBy,
    }),
  );
  signingKey = deriveSigningKey(issued.secret);
  pkg = createReplacementAuthorizationPackage({
    credentialSigningKey: signingKey,
    unsigned: {
      packageVersion: REPLACEMENT_PACKAGE_VERSION,
      protocolVersion: authorization.protocolVersion,
      credentialProtocol: REPLACEMENT_CREDENTIAL_PROTOCOL,
      credentialId: issued.credentialId,
      missionControlInstanceIdentity: MISSION_CONTROL_INSTANCE_ID,
      claimPath: REPLACEMENT_CLAIM_PATH,
      intentPath: REPLACEMENT_INTENT_PATH,
      receiptPath: REPLACEMENT_RECEIPT_PATH,
      decisionPath: REPLACEMENT_DECISION_PATH,
      statusPath: REPLACEMENT_STATUS_PATH,
      failurePath: REPLACEMENT_FAILURE_PATH,
      executionId: rollbackExecutionId,
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: authorization.approvedAt,
      expiresAt: authorization.expiresAt,
      maximumUseCount: 1,
      authorization,
      approval: {
        approvalId: authorization.approvalId,
        status: "granted",
        decidedBy: authorization.approvedBy,
        actionHash: authorizationChecksum(authorization),
        decidedAt: authorization.approvedAt,
        expiresAt: authorization.expiresAt,
      },
      authorizationFingerprint: authorizationChecksum(authorization),
      evidenceInstructions: {
        mode: "authenticated-receipt-api",
        localDirectory: authorization.evidenceDestination,
        receiptSequenceStartsAt: 1,
      },
    },
  });
  await withClient((client) => persistIssuedReplacementPackage({ client, pkg }));
  await withClient((client) =>
    confirmReplacementPackageClaim({
      client,
      workspaceId,
      agentId: authorization.agentId,
      credentialId: issued.credentialId,
      requestMessageId: randomUUID(),
      requestNonce: randomBytes(24).toString("base64url"),
      requestBodyChecksum: sha256("rollback-claim"),
      body: {
        authorizationId: authorization.authorizationId,
        executionId: rollbackExecutionId,
        packageChecksum: pkg.packageChecksum,
        nonce: pkg.nonce,
      },
    }),
  );
  await withClient((client) =>
    establishAuthoritativeReplacementDrain({
      client,
      workspaceId,
      authorizationId: authorization.authorizationId,
      executionId: rollbackExecutionId,
      agentId: authorization.agentId,
      stabilizationMs: 1_000,
    }),
  );
  const advance = async (operation, sequence, observation) => {
    const mutating = [
      "extract_node_runtime",
      "stop_service",
      "replace_artifact",
      "replace_plist",
      "start_service",
      "restore_artifact",
      "restore_plist",
      "restart_prior_service",
    ].includes(operation);
    const operationId = randomUUID();
    const postcondition = fixedConditionChecksum({
      operation,
      condition: "postcondition",
      authorizationFingerprint: authorizationChecksum(authorization),
    });
    if (mutating)
      await withClient((client) =>
        createReplacementMutationIntent({
          client,
          workspaceId,
          authenticatedCredentialId: issued.credentialId,
          authenticatedAgentId: authorization.agentId,
          binding: {
            requestMessageId: randomUUID(),
            requestNonce: randomBytes(24).toString("base64url"),
            requestBodyChecksum: sha256(`${operation}:${sequence}:rollback`),
          },
          request: {
            authorizationId: authorization.authorizationId,
            executionId: rollbackExecutionId,
            credentialId: issued.credentialId,
            agentId: authorization.agentId,
            providerIdentifier: REPLACEMENT_PROVIDER,
            authorizationFingerprint: authorizationChecksum(authorization),
            claimGeneration: 1,
            operationId,
            operation,
            sequence,
            fixedArgumentsChecksum: fixedOperationChecksum({
              operation,
              authorizationFingerprint: authorizationChecksum(authorization),
              executionId: rollbackExecutionId,
              claimGeneration: 1,
            }),
            expectedPreconditionChecksum: fixedConditionChecksum({
              operation,
              condition: "precondition",
              authorizationFingerprint: authorizationChecksum(authorization),
            }),
            expectedPostconditionChecksum: postcondition,
          },
        }),
      );
    const resolvedObservation = typeof observation === "function" ? await observation() : observation;
    const requestNonce = randomBytes(24).toString("base64url");
    const result = {
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      safeStdoutSummary: `${operation} passed`,
      safeStderrSummary: "",
      inspectedChecksums: {},
      changedChecksums: {},
    };
    const unsigned = {
      receiptVersion: "1",
      authorizationId: authorization.authorizationId,
      executionId: rollbackExecutionId,
      credentialId: issued.credentialId,
      agentId: authorization.agentId,
      providerIdentifier: REPLACEMENT_PROVIDER,
      authorizationFingerprint: authorizationChecksum(authorization),
      claimGeneration: 1,
      operationId,
      operation,
      sequence,
      requestNonce,
      receiptNonce: randomBytes(24).toString("base64url"),
      operationChecksum: fixedOperationChecksum({
        operation,
        authorizationFingerprint: authorizationChecksum(authorization),
        executionId: rollbackExecutionId,
        claimGeneration: 1,
      }),
      resultChecksum: mutating ? postcondition : sha256(canonicalJson(result)),
      hostJournalChecksum: sha256(`rollback-journal:${operation}:${sequence}`),
      recovery: false,
      ...result,
      observation: resolvedObservation ?? null,
    };
    const bytes = canonicalJson(unsigned);
    const receipt = {
      ...unsigned,
      receiptChecksum: sha256(bytes),
      authentication: createHmac("sha256", signingKey).update(bytes).digest("hex"),
    };
    return withClient((client) =>
      consumeGovernedReplacementReceipt({
        client,
        workspaceId,
        requestNonce,
        requestMessageId: randomUUID(),
        requestBodyChecksum: sha256(canonicalJson(receipt)),
        credentialId: issued.credentialId,
        receipt,
      }),
    );
  };
  let sequence = 1;
  for (const operation of [
    "inspect_host",
    "inspect_agent",
    "inventory_configuration",
    "verify_rollback_assets",
    "stage_node_archive",
    "verify_node_archive",
    "extract_node_runtime",
    "verify_node_executable",
    "stage_target_artifact",
    "verify_release",
    "stage_target_plist",
    "verify_target_plist",
    "drain_agent",
    "stop_service",
    "replace_artifact",
    "replace_plist",
    "start_service",
  ])
    await advance(operation, sequence++);
  await withClient((client) =>
    requireReplacementRollback({
      client,
      workspaceId,
      agentId: authorization.agentId,
      credentialId: issued.credentialId,
      authorizationId: authorization.authorizationId,
      executionId: rollbackExecutionId,
      authorizationFingerprint: authorizationChecksum(authorization),
      claimGeneration: 1,
      failureChecksum: sha256("injected-post-start-failure"),
      binding: {
        requestMessageId: randomUUID(),
        requestNonce: randomBytes(24).toString("base64url"),
        requestBodyChecksum: sha256("rollback-required"),
      },
    }),
  );
  await advance("restore_artifact", sequence++);
  await advance("restore_plist", sequence++);
  const priorProcess = {
    observationVersion: "mission-agent-process-v1",
    hostIdentity: authorization.hostIdentity,
    agentId: authorization.agentId,
    serviceLabel: "com.wallyweb.mission-agent",
    pid: 6068,
    parentPid: 1,
    processStartedAt: null,
    processOwner: "shawnwollenberg",
    nodeExecutable: "/usr/local/Cellar/node/24.10.0/bin/node",
    nodeVersion: "v24.10.0",
    artifactPath: "/Users/shawnwollenberg/.mission-agent/mission-agent-0.6.8.mjs",
    artifactChecksum: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
    processArgumentsChecksum: sha256(
      "/usr/local/Cellar/node/24.10.0/bin/node /Users/shawnwollenberg/.mission-agent/mission-agent-0.6.8.mjs run",
    ),
    launchdPlistChecksum: "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898",
    targetProcessAbsent: true,
  };
  await advance("restart_prior_service", sequence++, () => {
    priorProcess.processStartedAt = new Date().toISOString();
    return priorProcess;
  });
  await advance("verify_prior_runtime", sequence++, {
    ...priorProcess,
    rollbackInventoryChecksum: "2e7f074a890b1b6492ac76d1786b987c0a7417e50532a1e712699963b7e5f229",
    artifactByteLength: 117277,
    artifactMode: "0700",
    plistByteLength: 2308,
    plistMode: "0600",
    plistChecksum: "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898",
    configurationByteLength: 2034,
    configurationMode: "0600",
    configurationChecksum: "8db02e81b4b09945e164d7789e690ea7c3ad97ffb5e892ab7de559de38517742",
    owner: "shawnwollenberg",
    group: "staff",
    credentialMetadataPresent: true,
    credentialStorage: "macOS Keychain",
    credentialItemClass: "generic-password",
    credentialService: "Mission Agent",
    credentialAccount: authorization.agentId,
    credentialMetadataChecksum: sha256(
      canonicalJson({
        itemClass: "generic-password",
        service: "Mission Agent",
        account: authorization.agentId,
      }),
    ),
    environmentNames: ["MISSION_AGENT_HOME", "PATH"],
    environmentValueChecksums: {
      MISSION_AGENT_HOME: "0974bb09ab4b18256c3a16bb4c6997a1ce50d68d8317a0c1d1634ed5f68f526d",
      PATH: "34e696b0c29cbb879f48eb2d4e321f21f0e3eb053d495e010e8d867ae0ed926f",
    },
    standardOutputPath: "/Users/shawnwollenberg/.mission-agent/mission-agent.log",
    standardErrorPath: "/Users/shawnwollenberg/.mission-agent/mission-agent-error.log",
    runAtLoad: true,
    keepAlive: true,
  });
  await advance("verify_prior_identity", sequence++);
  const rollbackCredential = {
    workspace_id: workspaceId,
    agent_id: authorization.agentId,
    credential_id: issued.credentialId,
    credential_record_status: "active",
  };
  for (let heartbeat = 0; heartbeat < 3; heartbeat += 1)
    await processRemoteMessage(
      {
        protocolVersion: "1.0",
        messageId: randomUUID(),
        idempotencyKey: randomUUID(),
        agentId: authorization.agentId,
        workspaceId,
        sentAt: new Date(Date.parse(priorProcess.processStartedAt) + 50 + heartbeat).toISOString(),
        messageType: "AgentHeartbeat",
        correlationId: rollbackExecutionId,
        attempt: 1,
        payload: {
          assignmentPull: true,
          missionAgentVersion: "0.6.8",
          adapter: "codex",
          artifact: {
            sha256: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
            manifestVersion: "1",
          },
          repositoryIdentity: {
            stableProtocolVersion: "2",
            activationAcknowledgementVersion: "1",
            repositories: [
              {
                repositoryId: authorization.repositoryId,
                fingerprint: authorization.repositoryFingerprint,
              },
            ],
          },
          projectBrain: {
            installed: true,
            runtimeReady: true,
            coreVersion: "0.4.0",
            contractVersions: ["1.0"],
            schemaVersions: ["2.5.0"],
            operations: ["detect_repository"],
            readOperations: ["detect_repository"],
            writeOperations: [],
            diagnosticsStatus: "ready",
            maxRequestBytes: 1024,
            maxResultBytes: 1024,
            artifactTransferModes: ["inline_base64"],
          },
        },
      },
      rollbackCredential,
    );
  await advance("verify_prior_heartbeats", sequence++);
  await advance("verify_prior_capabilities", sequence++);
  const rollbackState = (
    await getDatabasePool().query(
      `SELECT a.mission_agent_version,a.mission_agent_artifact_checksum,a.last_heartbeat_at,
              p.advertised_version,p.advertised_checksum,r.repository_fingerprint
         FROM agents a
         JOIN mission_agent_capability_projections p
           ON p.workspace_id=a.workspace_id AND p.agent_id=a.agent_id
         JOIN repositories r ON r.workspace_id=a.workspace_id AND r.repository_id=$3
        WHERE a.workspace_id=$1 AND a.agent_id=$2`,
      [workspaceId, authorization.agentId, authorization.repositoryId],
    )
  ).rows[0];
  assert.equal(rollbackState.mission_agent_version, "0.6.8");
  assert.equal(
    rollbackState.mission_agent_artifact_checksum,
    "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
  );
  assert.equal(rollbackState.advertised_version, "0.6.8");
  assert.equal(rollbackState.advertised_checksum, "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d");
  assert.equal(rollbackState.repository_fingerprint, authorization.repositoryFingerprint);
  await advance("verify_prior_projection", sequence++);
  const terminal = await advance("report_evidence", sequence);
  assert.equal(terminal.state, "rolled-back");
  const final = await getDatabasePool().query(
    `SELECT c.state,c.completed_at,rc.consumed_at,ac.status credential_status,b.state authorization_state
       FROM mission_agent_replacement_execution_claims c
       JOIN mission_agent_replacement_credentials rc
         ON rc.workspace_id=c.workspace_id AND rc.credential_id=c.credential_id
       JOIN agent_credentials ac
         ON ac.workspace_id=c.workspace_id AND ac.credential_id=c.credential_id
       JOIN mission_agent_replacement_bootstraps b
         ON b.workspace_id=c.workspace_id AND b.authorization_id=c.authorization_id
      WHERE c.workspace_id=$1 AND c.authorization_id=$2 AND c.execution_id=$3`,
    [workspaceId, authorization.authorizationId, rollbackExecutionId],
  );
  assert.equal(final.rows[0].state, "rolled-back");
  assert.ok(final.rows[0].completed_at);
  assert.ok(final.rows[0].consumed_at);
  assert.equal(final.rows[0].credential_status, "revoked");
  assert.equal(final.rows[0].authorization_state, "rolled_back");
});
