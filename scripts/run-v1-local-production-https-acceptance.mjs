import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hash as bcryptHash } from "bcryptjs";
import pg from "pg";
import { createV1OperatorRequest, emptyV1OperatorJournal } from "../application/v1-macos-operator-journal.ts";
import {
  createV1HostIdentityKey,
  signV1HostStartupEvidence,
  signV1HostBoundPayload,
  verifyV1HostStartupEvidence,
  V1_HOST_IDENTITY_PROTOCOL,
} from "../application/v1-operator-host-identity.ts";
import { canonicalJson } from "../application/v1-production-runtime-identity.ts";
import {
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap.ts";
import { deriveSigningKey, sha256, signProtocolRequest } from "../remote-agent/protocol.ts";

const exec = promisify(execFile);
const databasePort = 55448;
const appPort = 3412;
const httpsPort = 3445;
const databaseName = "mission_control_v1_local_production_https";
const password = randomBytes(24).toString("base64url");
const databaseUrl = `postgresql://postgres:${password}@127.0.0.1:${databasePort}/${databaseName}`;
const container = `mc-v1-https-${randomBytes(5).toString("hex")}`;
const root = await mkdtemp(join(tmpdir(), "mission-control-v1-https-"));
const origin = `https://127.0.0.1:${httpsPort}`;
const ownerPassword = `v1-local-${randomBytes(12).toString("base64url")}`;
const ownerId = randomUUID();
let app;
let proxy;
let database;
let appOutput = "";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, args, env = {}) =>
  exec(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    maxBuffer: 30 * 1024 * 1024,
  });

async function waitFor(check, description) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function seed(client) {
  const authorization = validateReplacementAuthorization(
    JSON.parse(
      await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8"),
    ),
  );
  const workspaceId = authorization.workspaceId;
  const deploymentId = randomUUID();
  const configurationIds = Array.from({ length: 4 }, () => randomUUID());
  const operatorRelease = JSON.parse(await readFile("dist/mission-agent-replacement-operator-v1.json", "utf8"));
  const agentCredentialId = randomUUID();
  const agentCredentialSecret = randomBytes(32).toString("base64url");
  const hostKeyPath = join(root, "host-identity.pk8");
  const hostKey = await createV1HostIdentityKey(hostKeyPath);
  const hostId = randomUUID();
  const challengeId = randomUUID();
  const challengeNonce = randomBytes(24).toString("base64url");
  const measurementId = randomUUID();
  const releaseId = randomUUID();
  const challengeExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const startup = await signV1HostStartupEvidence(
    {
      protocolVersion: V1_HOST_IDENTITY_PROTOCOL,
      challengeId,
      challengeNonce,
      challengeExpiresAt,
      hostPublicKeySpki: hostKey.publicKeySpki,
      hostFingerprint: hostKey.fingerprint,
      operatorArtifactSha256: operatorRelease.sha256,
      operatorProtocolVersion: "1",
      macOSUserId: process.getuid?.() ?? 501,
      agentId: authorization.agentId,
      installationPath:
        "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs",
      launchAgentLabel: "com.wallyweb.mission-agent.replacement-operator",
      journalGeneration: 1,
      observedAt: new Date().toISOString(),
    },
    hostKeyPath,
  );
  verifyV1HostStartupEvidence({
    evidence: startup,
    expectedChallengeId: challengeId,
    expectedChallengeNonce: challengeNonce,
    expectedHostFingerprint: hostKey.fingerprint,
    expectedAgentId: authorization.agentId,
    expectedOperatorArtifactSha256: operatorRelease.sha256,
    expectedOperatorProtocolVersion: "1",
    expectedInstallationPath: startup.installationPath,
    expectedLaunchAgentLabel: startup.launchAgentLabel,
    expectedUserId: startup.macOSUserId,
    minimumJournalGeneration: 1,
  });
  await client.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'V1 local production HTTPS')", [
    workspaceId,
    `v1-local-${workspaceId}`,
  ]);
  await client.query("INSERT INTO users(id,email,display_name,password_hash) VALUES($1,$2,'V1 Owner',$3)", [
    ownerId,
    authorization.approvedBy.toLowerCase(),
    await bcryptHash(ownerPassword, 10),
  ]);
  await client.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [
    workspaceId,
    ownerId,
  ]);
  await client.query(
    `INSERT INTO agents(
      workspace_id,agent_id,name,adapter_type,capabilities,supported_domains,trust_level,status,
      delivery_mode,mission_agent_version,last_heartbeat_at,pull_ready_at,protocol_versions
    ) VALUES($1,$2,'Disposable V1 named canary','remote_http',
      '["repository-analysis","repository.read"]','["release-governance"]','high','active',
      'pull','0.7.2',clock_timestamp(),clock_timestamp(),'["1.0"]')`,
    [workspaceId, authorization.agentId],
  );
  await client.query(
    `INSERT INTO agent_credentials(
      workspace_id,credential_id,agent_id,version,secret_verifier,status,allowed_protocol_versions,
      created_at,verified_at
    ) VALUES($1,$2,$3,1,$4,'active','["1.0"]',clock_timestamp(),clock_timestamp())`,
    [workspaceId, agentCredentialId, authorization.agentId, deriveSigningKey(agentCredentialSecret)],
  );
  await client.query(
    `INSERT INTO repositories(
      workspace_id,repository_id,name,local_path,default_branch,allowed_agent_ids,location_mode,
      repository_fingerprint,read_allowed,write_allowed,identity_migration_status
    ) VALUES($1,$2,'V1 smoke',$3,'main',$4,'mission_agent',$5,true,false,'not_required')`,
    [
      workspaceId,
      authorization.repositoryId,
      `mission-agent://${authorization.repositoryFingerprint}`,
      JSON.stringify([authorization.agentId]),
      authorization.repositoryFingerprint,
    ],
  );
  await client.query(
    `INSERT INTO repository_identities(
      workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
      selected_remote,created_at,verified_at,verification_source,migration_status
    ) VALUES($1,$2,'stable-v2',$3,$4,'V1 smoke','origin',clock_timestamp(),clock_timestamp(),
      'v1-local-https','active')`,
    [
      workspaceId,
      authorization.repositoryId,
      authorization.repositoryFingerprint,
      `mission-agent://${authorization.repositoryFingerprint}`,
    ],
  );
  await client.query(
    `INSERT INTO agent_resource_permissions(workspace_id,agent_id,resource_type,resource_id,permissions)
     VALUES($1,$2,'repository',$3,'["read"]')`,
    [workspaceId, authorization.agentId, authorization.repositoryId],
  );
  const configurationChecksum = hash("v1-local-production-configuration");
  await client.query(
    `INSERT INTO mission_control_production_deployments(
      deployment_id,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
      ecs_deployment_id,task_definition_arn,task_arn,ecr_repository_arn,image_digest,task_role_arn,
      execution_role_arn,application_commit,build_identity_checksum,configuration_checksum,
      database_identity_checksum,attestation_checksum,attestation_expires_at
    ) VALUES($1,'production','661452835066','us-east-1',$2,$3,'local-ecs-deployment',$4,$5,$6,$7,$8,$9,
      $10,$11,$12,$13,$14,clock_timestamp()+interval '2 hours')`,
    [
      deploymentId,
      "arn:aws:ecs:us-east-1:661452835066:cluster/v1-local",
      "arn:aws:ecs:us-east-1:661452835066:service/v1-local",
      "arn:aws:ecs:us-east-1:661452835066:task-definition/v1-local:1",
      "arn:aws:ecs:us-east-1:661452835066:task/v1-local/one",
      "arn:aws:ecr:us-east-1:661452835066:repository/mission-control",
      `sha256:${hash("image")}`,
      "arn:aws:iam::661452835066:role/v1-local-task",
      "arn:aws:iam::661452835066:role/v1-local-execution",
      "0".repeat(40),
      hash("build"),
      configurationChecksum,
      hash("database"),
      hash("attestation"),
    ],
  );
  for (const [index, state] of ["disabled", "read_only_preflight", "migration_ready", "canary_authorized"].entries())
    await client.query(
      `INSERT INTO mission_control_v1_production_configurations(
        configuration_id,deployment_id,version,predecessor_id,configuration_checksum,state,evidence_checksum
      ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        configurationIds[index],
        deploymentId,
        index + 1,
        index === 0 ? null : configurationIds[index - 1],
        index === 3 ? configurationChecksum : hash(`configuration-${index}`),
        state,
        hash(`config-evidence-${index}`),
      ],
    );
  await client.query(
    `INSERT INTO mission_agent_v1_operator_releases(
      release_id,protocol_version,artifact_checksum,executable_path,launch_agent_label,
      manifest_checksum,status,approved_by,approved_at
    ) VALUES($1,'1',$2,$3,'com.wallyweb.mission-agent.replacement-operator',$4,'approved',$5,clock_timestamp())`,
    [
      releaseId,
      operatorRelease.sha256,
      operatorRelease.installPath,
      hash("operator-manifest"),
      authorization.approvedBy,
    ],
  );
  await client.query(
    `INSERT INTO mission_agent_v1_host_identities(
      workspace_id,host_id,agent_id,public_key_spki,public_key_fingerprint,owner_uid,status
    ) VALUES($1,$2,$3,$4,$5,$6,'active')`,
    [workspaceId, hostId, authorization.agentId, hostKey.publicKeySpki, hostKey.fingerprint, startup.macOSUserId],
  );
  await client.query(
    `INSERT INTO mission_agent_v1_host_challenges(
      workspace_id,challenge_id,host_id,challenge_nonce,expires_at,consumed_at,request_message_id
    ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)`,
    [workspaceId, challengeId, hostId, challengeNonce, challengeExpiresAt, randomUUID()],
  );
  await client.query(
    `INSERT INTO mission_agent_v1_host_measurements(
      workspace_id,measurement_id,challenge_id,host_id,operator_release_id,startup_evidence_checksum,
      startup_evidence,signature,journal_generation,observed_at,expires_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`,
    [
      workspaceId,
      measurementId,
      challengeId,
      hostId,
      releaseId,
      hash(canonicalJson(startup)),
      JSON.stringify(startup),
      startup.signature,
      startup.observedAt,
      new Date(Date.parse(startup.observedAt) + 14 * 60_000),
    ],
  );
  return {
    authorization,
    workspaceId,
    deploymentId,
    configurationId: configurationIds[3],
    operatorRelease,
    agentCredentialId,
    agentCredentialSecret,
    hostKeyPath,
  };
}

async function insertAuthorization(client, base, authorizationId = base.authorization.authorizationId) {
  const authorization = {
    ...base.authorization,
    authorizationId,
    approvalId: randomUUID(),
    approvedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
  const missionId = randomUUID();
  await client.query(
    `INSERT INTO approval_projections(
      workspace_id,approval_id,mission_id,aggregate_version,approval_type,requested_action,action_hash,
      risk_explanation,evidence,requested_by,status,decided_by,expires_at,created_at,decided_at
    ) VALUES($1,$2,$3,1,'replacement-bootstrap',$4,$5,'v1 local accepted scope',$6,
      'v1-owner','granted',$7,$8,$9,$9)`,
    [
      base.workspaceId,
      authorization.approvalId,
      missionId,
      JSON.stringify({ authorizationId }),
      authorizationChecksum(authorization),
      JSON.stringify(authorization.evidenceReferences),
      authorization.approvedBy,
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  await client.query(
    `INSERT INTO mission_agent_replacement_bootstraps(
      workspace_id,authorization_id,approval_id,agent_id,protocol_version,authorization_record,
      authorization_checksum,state,aggregate_version,execution_count,expires_at,created_at,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,'approved',1,0,$8,$9,$9)`,
    [
      base.workspaceId,
      authorizationId,
      authorization.approvalId,
      authorization.agentId,
      authorization.protocolVersion,
      JSON.stringify(authorization),
      authorizationChecksum(authorization),
      authorization.expiresAt,
      authorization.approvedAt,
    ],
  );
  return authorization;
}

async function login(email) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password: ownerPassword }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

async function authorize(cookie, base, authorizationId) {
  const response = await fetch(`${origin}/api/mission-agent/replacement-bootstrap/authorize`, {
    method: "POST",
    headers: { origin, cookie, "content-type": "application/json" },
    body: JSON.stringify({
      authorizationId,
      deploymentId: base.deploymentId,
      configurationId: base.configurationId,
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

function signedClient(issued, agentId) {
  const credentialKey = deriveSigningKey(issued.secret);
  return {
    credentialKey,
    async post(path, value, expectedStatus = 200, options = {}) {
      const body = canonicalJson(value);
      const timestamp = new Date().toISOString();
      const nonce = options.nonce ?? randomBytes(24).toString("base64url");
      const messageId = options.messageId ?? randomUUID();
      const bodyChecksum = sha256(body);
      const signature = signProtocolRequest(credentialKey, {
        method: "POST",
        path,
        timestamp,
        nonce,
        messageId,
        protocolVersion: "replacement-bootstrap-v1",
        bodyChecksum,
      });
      const response = await fetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-mc-agent-id": options.agentId ?? agentId,
          "x-mc-credential-id": options.credentialId ?? issued.credentialId,
          "x-mc-timestamp": timestamp,
          "x-mc-nonce": nonce,
          "x-mc-message-id": messageId,
          "x-mc-protocol-version": "replacement-bootstrap-v1",
          "x-mc-body-sha256": bodyChecksum,
          "x-mc-signature": options.signature ?? signature,
        },
        body,
      });
      const text = await response.text();
      assert.equal(response.status, expectedStatus, `${path}: ${text}\n${appOutput}`);
      return JSON.parse(text);
    },
  };
}

async function agentProtocolPost(base, path, message, extraHeaders = {}, expectedStatuses = [200, 202]) {
  const key = deriveSigningKey(base.agentCredentialSecret);
  const body = canonicalJson(message);
  const timestamp = message.sentAt;
  const nonce = randomBytes(24).toString("base64url");
  const bodyChecksum = sha256(body);
  const signature = signProtocolRequest(key, {
    method: "POST",
    path,
    timestamp,
    nonce,
    messageId: message.messageId,
    protocolVersion: "1.0",
    bodyChecksum,
  });
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mc-agent-id": base.authorization.agentId,
      "x-mc-credential-id": base.agentCredentialId,
      "x-mc-timestamp": timestamp,
      "x-mc-nonce": nonce,
      "x-mc-message-id": message.messageId,
      "x-mc-protocol-version": "1.0",
      "x-mc-body-sha256": bodyChecksum,
      "x-mc-signature": signature,
      ...extraHeaders,
    },
    body,
  });
  const text = await response.text();
  assert.ok(expectedStatuses.includes(response.status), `${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

function agentEnvelope(base, messageType, payload, correlation = {}) {
  return {
    protocolVersion: "1.0",
    messageId: randomUUID(),
    idempotencyKey: randomUUID(),
    agentId: base.authorization.agentId,
    workspaceId: base.workspaceId,
    sentAt: new Date().toISOString(),
    messageType,
    correlationId: correlation.executionId ?? base.authorization.agentId,
    ...correlation,
    payload,
  };
}

async function advertiseCompatibleAgent(base) {
  for (let index = 0; index < 3; index += 1) {
    await agentProtocolPost(
      base,
      "/api/agent-protocol/v1/messages",
      agentEnvelope(base, "AgentHeartbeat", {
        assignmentPull: true,
        missionAgentVersion: "0.7.2",
        adapter: "codex",
        artifact: {
          sha256: "108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09",
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
              repositoryId: base.authorization.repositoryId,
              fingerprint: base.authorization.repositoryFingerprint,
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
      }),
      {},
      [202],
    );
  }
}

async function advertiseRestoredAgent(base, databaseClient) {
  await databaseClient.query(
    `DELETE FROM protocol_rate_limits
      WHERE workspace_id=$1 AND agent_id=$2 AND category='agent_heartbeat'`,
    [base.workspaceId, base.authorization.agentId],
  );
  for (let index = 0; index < 3; index += 1)
    await agentProtocolPost(
      base,
      "/api/agent-protocol/v1/messages",
      agentEnvelope(base, "AgentHeartbeat", {
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
              repositoryId: base.authorization.repositoryId,
              fingerprint: base.authorization.repositoryFingerprint,
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
      }),
      {},
      [202],
    );
}

async function recordRestoredProcessObservations(context) {
  const receipt = (
    await context.database.query(
      `SELECT r.receipt_checksum,r.resulting_state_checksum,r.executed_at
         FROM mission_agent_v1_provider_receipts r
         JOIN mission_agent_v1_provider_mutations m
           ON m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
          AND m.execution_id=r.execution_id AND m.provider_mutation_id=r.provider_mutation_id
        WHERE r.workspace_id=$1 AND r.authorization_id=$2 AND r.execution_id=$3
          AND m.phase='rollback'
        ORDER BY r.executed_at DESC,r.receipt_message_id DESC LIMIT 1`,
      [context.authorization.workspaceId, context.authorization.authorizationId, context.issued.executionId],
    )
  ).rows[0];
  assert.ok(receipt, "terminal rollback receipt must exist before host observation");
  const processStartedAt = new Date(Date.now() + 10).toISOString();
  for (let ordinal = 1; ordinal <= 2; ordinal += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const observedAt = new Date().toISOString();
    const processEvidence = {
      evidenceVersion: "mission-agent-v1-host-signed-restored-process-v1",
      authorizationId: context.authorization.authorizationId,
      executionId: context.issued.executionId,
      terminalReceiptChecksum: receipt.receipt_checksum,
      terminalStateChecksum: receipt.resulting_state_checksum,
      fencingGeneration: context.fence,
      observationOrdinal: ordinal,
      pid: 9000,
      processStartedAt,
      nodeExecutable: "/usr/local/Cellar/node/24.10.0/bin/node",
      nodeVersion: "v24.10.0",
      artifactChecksum: "e6cdf9d962231844b1887959411a8d262bf9371092eb0e789a4971ba3c3fc28d",
      launchdPlistChecksum: "3adfe6e3e0119871dcc8ba1977bc8af953accbcc51424eb13e1f1070f8789898",
      targetProcessAbsent: true,
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
      credentialAccount: context.authorization.agentId,
      credentialMetadataChecksum: hash(
        canonicalJson({
          itemClass: "generic-password",
          service: "Mission Agent",
          account: context.authorization.agentId,
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
    };
    const result = await transition(
      context.client,
      context.issued,
      context.authorization,
      "status",
      "rollback_observation",
      context.state,
      context.sequence,
      context.fence,
      { observedAt, processEvidence },
    );
    context.state = result.state;
    context.sequence = result.sequence;
  }
}

async function completeGovernedSmoke(base, smoke) {
  const leaseOwner = `v1-local-${randomUUID()}`;
  let assignment;
  for (let attempt = 0; attempt < 80 && !assignment; attempt += 1) {
    const pull = await agentProtocolPost(
      base,
      "/api/agent-protocol/v1/assignments/pull",
      agentEnvelope(base, "AgentAssignmentPullRequested", { leaseOwner, waitSeconds: 0 }),
    );
    assignment = pull?.assignment;
    if (!assignment) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(assignment, "governed read-only smoke assignment was not leased");
  assert.equal(assignment.executionId, smoke.executionId);
  const leaseHeaders = {
    "x-mc-assignment-id": assignment.assignmentId,
    "x-mc-lease-owner": leaseOwner,
    "x-mc-lease-token": assignment.leaseToken,
  };
  const correlation = {
    missionId: assignment.missionId,
    taskId: assignment.taskId,
    executionId: assignment.executionId,
    attempt: assignment.attempt,
  };
  await agentProtocolPost(
    base,
    `/api/agent-protocol/v1/assignments/${assignment.assignmentId}/acknowledge`,
    agentEnvelope(base, "AgentAssignmentAcknowledged", { leaseOwner, leaseToken: assignment.leaseToken }, correlation),
  );
  await agentProtocolPost(
    base,
    "/api/agent-protocol/v1/messages",
    agentEnvelope(
      base,
      "ExecutionHeartbeat",
      {
        workerId: leaseOwner,
        stage: "read_only_verification",
        summary: "V1 governed read-only smoke is active.",
        progressPercent: 50,
      },
      correlation,
    ),
    leaseHeaders,
    [202],
  );
  const artifact = Buffer.from(
    `${canonicalJson({
      evidenceVersion: "v1-governed-read-only-smoke-v1",
      repositoryId: assignment.repositoryId,
      repositoryFingerprint: assignment.repositoryFingerprint,
      readOnly: true,
      sideEffects: [],
    })}\n`,
  );
  await agentProtocolPost(
    base,
    "/api/agent-protocol/v1/messages",
    agentEnvelope(
      base,
      "ExecutionArtifactSubmitted",
      {
        name: "v1-governed-read-only-smoke",
        description: "Local V1 governed read-only smoke evidence",
        artifactType: "replacement_read_only_smoke",
        mediaType: "application/json",
        byteSize: artifact.byteLength,
        checksum: hash(artifact),
        contentBase64: artifact.toString("base64"),
      },
      correlation,
    ),
    leaseHeaders,
    [202],
  );
  await agentProtocolPost(
    base,
    "/api/agent-protocol/v1/messages",
    agentEnvelope(base, "ExecutionSucceeded", { summary: "V1 governed read-only smoke completed." }, correlation),
    leaseHeaders,
    [202],
  );
}

async function transition(client, issued, authorization, handler, action, state, sequence, fence, extra = {}) {
  const body = {
    authorizationId: authorization.authorizationId,
    executionId: issued.executionId,
    authorizationFingerprint: issued.authorizationFingerprint,
    claimGeneration: 1,
    action,
    expectedState: state,
    expectedSequence: sequence,
    fencingGeneration: fence,
    eventId: randomUUID(),
    ...extra,
  };
  if (
    (handler === "status" &&
      ["acknowledge_grant", "anchor_durable_receipt", "rollback_observation"].includes(action)) ||
    (handler === "receipt" && action === "accept_provider_receipt")
  )
    body.hostSignature = await signV1HostBoundPayload(body, client.hostKeyPath);
  return client.post(`/api/mission-agent/replacement-bootstrap/${handler}`, body);
}

async function operationalSnapshot(database, workspaceId, authorizationId) {
  const tables = [
    "mission_agent_v1_rollout_operations",
    "mission_agent_v1_lifecycle_events",
    "mission_agent_v1_grants",
    "mission_agent_v1_rollback_obligations",
    "mission_agent_v1_operator_confirmations",
    "mission_agent_v1_durable_receipt_anchors",
    "mission_agent_v1_provider_mutations",
    "mission_agent_v1_provider_receipts",
    "mission_agent_v1_verified_evidence",
    "mission_agent_v1_closure_evidence",
    "mission_agent_replacement_evidence",
    "mission_agent_replacement_execution_claims",
    "mission_agent_replacement_mutation_intents",
    "mission_agent_replacement_receipts",
    "mission_agent_replacement_credentials",
    "mission_agent_replacement_bootstraps",
  ];
  const snapshot = {};
  for (const table of tables) {
    const result = await database.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows
         FROM ${table} t WHERE workspace_id=$1 AND authorization_id=$2`,
      [workspaceId, authorizationId],
    );
    snapshot[table] = hash(canonicalJson(result.rows[0].rows));
  }
  return snapshot;
}

async function verifySixHandlerRejectionMatrix(database, context) {
  const handlers = {
    claim: "preflight",
    intent: "propose_grant",
    receipt: "accept_provider_receipt",
    decision: "verify_provider_receipt",
    status: "record_grant_delivery",
    failure: "activate_rollback",
  };
  const results = [];
  for (const [handler, action] of Object.entries(handlers)) {
    const cases = [
      ["wrong-authorization-fingerprint", { authorizationFingerprint: hash("wrong-authorization") }],
      ["wrong-authorization", { authorizationId: randomUUID() }],
      ["wrong-execution", { executionId: randomUUID() }],
      ["invalid-state-transition", { expectedState: "success_verified" }],
      ["invalid-sequence", { expectedSequence: 99 }],
      ["stale-fencing-generation", { fencingGeneration: 99 }],
      ["invalid-claim-generation", { claimGeneration: 2 }],
      ["malformed-event-id", { eventId: "not-a-uuid" }],
      ["unknown-request-field", { unknownField: "rejected" }],
    ];
    for (const [caseName, mutation] of cases) {
      const before = await operationalSnapshot(
        database,
        context.authorization.workspaceId,
        context.authorization.authorizationId,
      );
      await transition(
        context.client,
        context.issued,
        context.authorization,
        handler,
        action,
        "prepared",
        0,
        1,
        mutation,
      ).then(
        () => assert.fail(`${handler}/${JSON.stringify(mutation)} unexpectedly passed`),
        (error) => assert.match(String(error), /403/),
      );
      assert.deepEqual(
        await operationalSnapshot(database, context.authorization.workspaceId, context.authorization.authorizationId),
        before,
      );
      results.push({
        handler,
        case: caseName,
        beforeChecksum: hash(canonicalJson(before)),
        afterChecksum: hash(canonicalJson(before)),
      });
    }
    const body = {
      authorizationId: context.authorization.authorizationId,
      executionId: context.issued.executionId,
      authorizationFingerprint: context.issued.authorizationFingerprint,
      claimGeneration: 1,
      action,
      expectedState: "success_verified",
      expectedSequence: 0,
      fencingGeneration: 1,
      eventId: randomUUID(),
    };
    for (const [caseName, options] of [
      ["wrong-canary", { agentId: randomUUID() }],
      ["invalid-credential", { credentialId: randomUUID() }],
      ["invalid-signature", { signature: "00".repeat(64) }],
    ]) {
      const before = await operationalSnapshot(
        database,
        context.authorization.workspaceId,
        context.authorization.authorizationId,
      );
      await context.client.post(`/api/mission-agent/replacement-bootstrap/${handler}`, body, 403, options);
      const after = await operationalSnapshot(
        database,
        context.authorization.workspaceId,
        context.authorization.authorizationId,
      );
      assert.deepEqual(after, before);
      results.push({
        handler,
        case: caseName,
        beforeChecksum: hash(canonicalJson(before)),
        afterChecksum: hash(canonicalJson(after)),
      });
    }
    const replayNonce = randomBytes(24).toString("base64url");
    const replayMessageId = randomUUID();
    const beforeReplay = await operationalSnapshot(
      database,
      context.authorization.workspaceId,
      context.authorization.authorizationId,
    );
    await context.client.post(`/api/mission-agent/replacement-bootstrap/${handler}`, body, 403, {
      nonce: replayNonce,
      messageId: replayMessageId,
    });
    await context.client.post(`/api/mission-agent/replacement-bootstrap/${handler}`, body, 403, {
      nonce: replayNonce,
      messageId: replayMessageId,
    });
    const afterReplay = await operationalSnapshot(
      database,
      context.authorization.workspaceId,
      context.authorization.authorizationId,
    );
    assert.deepEqual(afterReplay, beforeReplay);
    results.push({
      handler,
      case: "reused-nonce-and-message-id",
      beforeChecksum: hash(canonicalJson(beforeReplay)),
      afterChecksum: hash(canonicalJson(afterReplay)),
    });
  }
  return results;
}

async function runMutation(context, operationExpected, finalAction = "continue_forward") {
  const { client, issued, authorization, journalPath } = context;
  const grantResult = await transition(
    client,
    issued,
    authorization,
    "intent",
    "propose_grant",
    context.state,
    context.sequence,
    context.fence,
  );
  const grant = grantResult.grant;
  assert.equal(grant.allowedOperation, operationExpected);
  context.state = grantResult.state;
  context.sequence = grantResult.sequence;
  const delivered = await transition(
    client,
    issued,
    authorization,
    "status",
    "record_grant_delivery",
    context.state,
    context.sequence,
    context.fence,
    {
      grantId: grant.grantId,
      grantChecksum: hash(canonicalJson(grant)),
    },
  );
  context.state = delivered.state;
  context.sequence = delivered.sequence;
  const journal = (await import("../application/v1-macos-operator-journal.ts")).readV1OperatorJournal
    ? await (
        await import("../application/v1-macos-operator-journal.ts")
      ).readV1OperatorJournal(journalPath, client.credentialKey)
    : null;
  const currentJournal = journal ?? emptyV1OperatorJournal(grant.binding, client.credentialKey);
  const acknowledged = await transition(
    client,
    issued,
    authorization,
    "status",
    "acknowledge_grant",
    context.state,
    context.sequence,
    context.fence,
    {
      grantId: grant.grantId,
      grantChecksum: hash(canonicalJson(grant)),
      acknowledgementChecksum: hash(`ack:${grant.grantId}`),
      operatorJournalChecksum: currentJournal.journalChecksum,
    },
  );
  context.state = acknowledged.state;
  context.sequence = acknowledged.sequence;
  const committed = await transition(
    client,
    issued,
    authorization,
    "intent",
    "commit_mutation_intent",
    context.state,
    context.sequence,
    context.fence,
    {
      grantId: grant.grantId,
      operationId: grant.operationId,
      operation: grant.allowedOperation,
      fixedArgumentsChecksum: hash(`fixed:${grant.allowedOperation}`),
      expectedPreconditionChecksum: currentJournal.journalChecksum,
      expectedPostconditionChecksum: hash(`post:${grant.allowedOperation}`),
      fromState: "precondition",
      toState: "postcondition",
      intentChecksum: hash(`intent:${grant.operationId}`),
    },
  );
  context.state = committed.state;
  context.sequence = committed.sequence;
  const request = createV1OperatorRequest(
    {
      ...grant.binding,
      currentControllerDeploymentId: grant.currentControllerDeploymentId,
      currentControllerFencingGeneration: grant.currentControllerFencingGeneration,
      grantId: grant.grantId,
      grantChecksum: hash(canonicalJson(grant)),
      operation: grant.allowedOperation,
      providerMutationId: grant.providerMutationId,
      sequence: grant.sequence,
      requestMessageId: randomUUID(),
      nonce: randomBytes(24).toString("base64url"),
      issuedAt: grant.issuedAt,
      forwardExpiresAt: grant.expiresAt,
      expectedJournalChecksum: currentJournal.journalChecksum,
    },
    client.credentialKey,
  );
  const processInputPath = join(root, `${grant.providerMutationId}-operator-input.json`);
  const processInput = {
    request,
    expectedBinding: grant.binding,
    credentialKey: client.credentialKey,
    boundary: {
      executablePath:
        "/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs",
      executableChecksum: grant.approvedExecutableChecksum,
      expectedUid: process.getuid?.() ?? 501,
      actualUid: process.getuid?.() ?? 501,
      platform: "darwin",
      journalPath,
    },
    origin,
    agentId: authorization.agentId,
    credentialId: issued.credentialId,
    authorizationId: authorization.authorizationId,
    executionId: issued.executionId,
    authorizationFingerprint: issued.authorizationFingerprint,
    expectedState: grant.grantKind === "forward" ? "mutation_intent_committed" : "rollback_intent_committed",
    expectedSequence: grant.lifecycleSequence + 3,
    fencingGeneration: context.fence,
    grantId: grant.grantId,
    providerStatePath: context.providerStatePath,
    crashBoundary: context.crashBoundary,
  };
  await writeFile(processInputPath, `${JSON.stringify(processInput)}\n`, { mode: 0o600 });
  await run(process.execPath, ["--import", "tsx", "scripts/v1-disposable-operator-process.mjs", processInputPath]).then(
    () => assert.fail("disposable operator process did not stop at its configured crash boundary"),
    (error) => assert.ok([71, 72].includes(error.code), `unexpected operator exit ${error.code}: ${error.stderr}`),
  );
  if (context.verifyRevocationRaceOnce) {
    context.verifyRevocationRaceOnce = false;
    const beforeRevocation = await operationalSnapshot(
      context.database,
      authorization.workspaceId,
      authorization.authorizationId,
    );
    await transition(
      client,
      issued,
      authorization,
      "decision",
      "revoke_grant",
      grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt",
      grant.lifecycleSequence + 4,
      context.fence,
      {
        grantId: grant.grantId,
        grantChecksum: hash(canonicalJson(grant)),
        revocationReasonChecksum: hash("revocation-after-operator-confirmation-must-fail"),
      },
    ).then(
      () => assert.fail("revocation after operator confirmation unexpectedly passed"),
      (error) => assert.match(String(error), /403/),
    );
    assert.deepEqual(
      await operationalSnapshot(context.database, authorization.workspaceId, authorization.authorizationId),
      beforeRevocation,
    );
  }
  const recoveryInput = { ...processInput, crashBoundary: "none" };
  await writeFile(processInputPath, `${JSON.stringify(recoveryInput)}\n`, { mode: 0o600 });
  const recoveredProcess = await run(process.execPath, [
    "--import",
    "tsx",
    "scripts/v1-disposable-operator-process.mjs",
    processInputPath,
  ]);
  const operatorResult = JSON.parse(recoveredProcess.stdout.trim());
  context.confirmedJournalChecksum = operatorResult.confirmedJournalChecksum;
  context.state = grant.grantKind === "forward" ? "awaiting_provider_receipt" : "awaiting_rollback_receipt";
  context.sequence = grant.lifecycleSequence + 4;
  assert.equal(operatorResult.disposition, "receipt_recovered");
  const receipt = operatorResult.providerReceipt.receipt;
  const anchored = await transition(
    client,
    issued,
    authorization,
    "status",
    "anchor_durable_receipt",
    context.state,
    context.sequence,
    context.fence,
    {
      grantId: grant.grantId,
      providerMutationId: grant.providerMutationId,
      receiptChecksum: operatorResult.receiptChecksum,
    },
  );
  context.state = anchored.state;
  context.sequence = anchored.sequence;
  let adoptedFence;
  if (context.delayReceiptPastGrantExpiryOnce) {
    context.delayReceiptPastGrantExpiryOnce = false;
    await context.database.query(
      `UPDATE mission_agent_v1_grants SET expires_at=$4
        WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3 AND grant_id=$5`,
      [
        authorization.workspaceId,
        authorization.authorizationId,
        issued.executionId,
        new Date(Date.parse(receipt.completedAt) + 25),
        grant.grantId,
      ],
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (context.replaceControllerBeforeReceiptOnce) {
    context.replaceControllerBeforeReceiptOnce = false;
    const newDeploymentId = randomUUID();
    const attestationChecksum = hash(`replacement-controller:${newDeploymentId}`);
    await context.database.query(
      `INSERT INTO mission_control_production_deployments(
        deployment_id,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
        ecs_deployment_id,task_definition_arn,task_arn,ecr_repository_arn,image_digest,
        task_role_arn,execution_role_arn,application_commit,build_identity_checksum,
        configuration_checksum,database_identity_checksum,attestation_checksum,attestation_expires_at
      ) SELECT $1,environment,aws_account_id,aws_region,ecs_cluster_arn,ecs_service_arn,
        $2,$3,$4,ecr_repository_arn,image_digest,task_role_arn,execution_role_arn,
        application_commit,build_identity_checksum,configuration_checksum,database_identity_checksum,
        $5,clock_timestamp()+interval '1 hour'
        FROM mission_control_production_deployments WHERE deployment_id=$6`,
      [
        newDeploymentId,
        `local-recovery-${newDeploymentId}`,
        `arn:aws:ecs:us-east-1:661452835066:task-definition/v1:${context.fence + 1}`,
        `arn:aws:ecs:us-east-1:661452835066:task/v1/${newDeploymentId}`,
        attestationChecksum,
        context.originDeploymentId,
      ],
    );
    const adopted = await transition(
      client,
      issued,
      authorization,
      "claim",
      "adopt_recovery_controller",
      context.state,
      context.sequence,
      context.fence,
      { newControllerDeploymentId: newDeploymentId, controllerEvidenceChecksum: attestationChecksum },
    );
    adoptedFence = adopted.fencingGeneration;
  }
  const accepted = await transition(
    client,
    issued,
    authorization,
    "receipt",
    "accept_provider_receipt",
    context.state,
    context.sequence,
    context.fence,
    {
      grantId: grant.grantId,
      providerMutationId: grant.providerMutationId,
      operation: grant.allowedOperation,
      priorStateChecksum: request.expectedJournalChecksum,
      resultingStateChecksum: receipt.resultChecksum,
      localJournalEntryId: operatorResult.localJournalEntryId,
      executedAt: receipt.completedAt,
      operatorRequestMessageId: request.requestMessageId,
      operatorRequestNonce: request.nonce,
      priorOperatorJournalChecksum: context.confirmedJournalChecksum,
      operatorJournalChecksum: operatorResult.operatorJournalChecksum,
      receiptBytes: operatorResult.receiptBytes,
      receiptChecksum: operatorResult.receiptChecksum,
      authenticatedReceiptTag: operatorResult.providerReceipt.authenticationTag,
      verificationEvidenceChecksum: receipt.resultChecksum,
      outcome: "succeeded",
    },
  );
  context.state = accepted.state;
  context.sequence = accepted.sequence;
  if (adoptedFence) context.fence = adoptedFence;
  const recovered = await transition(
    client,
    issued,
    authorization,
    "receipt",
    "accept_provider_receipt",
    "intentionally-stale",
    0,
    context.fence,
    {
      providerMutationId: grant.providerMutationId,
      receiptChecksum: operatorResult.receiptChecksum,
    },
  );
  assert.equal(recovered.recovered, true);
  const verified = await transition(
    client,
    issued,
    authorization,
    "decision",
    "verify_provider_receipt",
    context.state,
    context.sequence,
    context.fence,
  );
  context.state = verified.state;
  context.sequence = verified.sequence;
  if (!finalAction) return verified;
  if (finalAction === "observe_stability") await context.prepareSmoke();
  const next = await transition(
    client,
    issued,
    authorization,
    "decision",
    finalAction,
    context.state,
    context.sequence,
    context.fence,
  );
  context.state = next.state;
  context.sequence = next.sequence;
  return next;
}

async function runtimeEvidence(context, type) {
  const source = await context.database.query(
    `SELECT evidence_checksum FROM mission_agent_replacement_evidence
      WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3
        AND evidence_type=$4 ORDER BY observed_at DESC LIMIT 1`,
    [context.authorization.workspaceId, context.authorization.authorizationId, context.issued.executionId, type],
  );
  assert.ok(source.rows[0]?.evidence_checksum, `canonical ${type} evidence must exist`);
  const result = await transition(
    context.client,
    context.issued,
    context.authorization,
    "status",
    "runtime_status",
    context.state,
    context.sequence,
    context.fence,
    {
      evidenceType: type,
      sourceEvidenceChecksum: source.rows[0].evidence_checksum,
    },
  );
  context.state = result.state;
  context.sequence = result.sequence;
  return result.evidenceChecksum;
}

async function scenario(clientDb, cookie, base, name, rollbackPrefix = 0) {
  const rollback = rollbackPrefix > 0;
  const authorization = await insertAuthorization(
    clientDb,
    base,
    rollback ? randomUUID() : base.authorization.authorizationId,
  );
  const issued = await authorize(cookie, base, authorization.authorizationId);
  const client = signedClient(issued, authorization.agentId);
  const state = { path: join(root, `${name}-provider.json`), mutations: {}, counts: {} };
  await writeFile(state.path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  const context = {
    authorization,
    issued,
    client,
    providerStatePath: state.path,
    database: clientDb,
    originDeploymentId: base.deploymentId,
    journalPath: join(root, `${name}-journal.json`),
    state: "prepared",
    sequence: 0,
    fence: 1,
    crashBoundary: rollback ? "after-receipt" : "after-provider",
    delayReceiptPastGrantExpiryOnce: name === "rollback-prefix-2",
    replaceControllerBeforeReceiptOnce: name === "rollback-prefix-3",
    fullRejectionMatrix: name === "success",
    verifyRevocationRaceOnce: name === "success",
    prepareSmoke: async () => advertiseCompatibleAgent(base),
  };
  client.hostKeyPath = base.hostKeyPath;
  context.rejectionResults = context.fullRejectionMatrix
    ? await verifySixHandlerRejectionMatrix(clientDb, context)
    : [];
  for (const [action, expected] of [
    ["preflight", "prepared"],
    ["request_drain", "preflight_verified"],
    ["verify_drain", "drain_requested"],
    ["acquire_lease", "drained_verified"],
  ]) {
    const result = await transition(
      client,
      issued,
      authorization,
      "claim",
      action,
      expected,
      context.sequence,
      context.fence,
      {
        ...(action === "verify_drain" ? { drainEvidenceChecksum: hash(`${name}:drain`) } : {}),
      },
    );
    context.state = result.state;
    context.sequence = result.sequence;
  }
  if (!rollback) {
    const operations = ["stage_artifact", "stop_agent", "install_agent", "install_launch_configuration", "start_agent"];
    let finalMutationResult;
    for (let index = 0; index < operations.length; index += 1) {
      finalMutationResult = await runMutation(
        context,
        operations[index],
        index === operations.length - 1 ? "observe_stability" : "continue_forward",
      );
    }
    assert.ok(finalMutationResult?.smoke);
    await completeGovernedSmoke(base, finalMutationResult.smoke);
    const evaluationTransition = await transition(
      client,
      issued,
      authorization,
      "decision",
      "evaluate_stability",
      context.state,
      context.sequence,
      context.fence,
    );
    assert.equal(evaluationTransition.evaluation?.decision, "continue");
    context.state = evaluationTransition.state;
    context.sequence = evaluationTransition.sequence;
    const checksums = {};
    for (const type of ["process", "heartbeat-capability", "projection", "smoke"])
      checksums[type] = await runtimeEvidence(context, type);
    const closed = await transition(
      client,
      issued,
      authorization,
      "decision",
      "close_success",
      context.state,
      context.sequence,
      context.fence,
      {
        processChecksum: checksums.process,
        heartbeatChecksum: checksums["heartbeat-capability"],
        projectionChecksum: checksums.projection,
        inventoryChecksum: checksums.smoke,
      },
    );
    context.state = closed.state;
    context.sequence = closed.sequence;
  } else {
    const forwardOperations = [
      "stage_artifact",
      "stop_agent",
      "install_agent",
      "install_launch_configuration",
      "start_agent",
    ];
    for (const operation of forwardOperations.slice(0, rollbackPrefix)) {
      await runMutation(context, operation);
    }
    const failure = await transition(
      client,
      issued,
      authorization,
      "failure",
      "activate_rollback",
      context.state,
      context.sequence,
      context.fence,
      {
        failureChecksum: hash(`${name}:forced-post-mutation-failure`),
      },
    );
    context.state = failure.state;
    context.sequence = failure.sequence;
    const rollbackPlan = (
      await clientDb.query(
        `SELECT required_inverse_operations FROM mission_agent_v1_rollback_obligations
          WHERE workspace_id=$1 AND authorization_id=$2 AND execution_id=$3`,
        [base.workspaceId, authorization.authorizationId, issued.executionId],
      )
    ).rows[0].required_inverse_operations;
    for (const operation of rollbackPlan) {
      await runMutation(context, operation, null);
      if (operation !== rollbackPlan.at(-1)) {
        const continued = await transition(
          client,
          issued,
          authorization,
          "decision",
          "continue_rollback",
          context.state,
          context.sequence,
          context.fence,
        );
        context.state = continued.state;
        context.sequence = continued.sequence;
      }
    }
    await recordRestoredProcessObservations(context);
    await advertiseRestoredAgent(base, clientDb);
    const rollbackChecksum = hash(`server-derived-rollback-evidence:${authorization.authorizationId}`);
    const beforeRejectedClose = await operationalSnapshot(
      clientDb,
      authorization.workspaceId,
      authorization.authorizationId,
    );
    await transition(
      client,
      issued,
      authorization,
      "decision",
      "close_rollback",
      "recovery_only",
      context.sequence,
      context.fence,
      {
        processChecksum: rollbackChecksum,
        heartbeatChecksum: rollbackChecksum,
        projectionChecksum: rollbackChecksum,
        inventoryChecksum: rollbackChecksum,
      },
    ).then(
      () => assert.fail("stale rollback closure unexpectedly passed"),
      (error) => assert.match(String(error), /403/),
    );
    assert.deepEqual(
      await operationalSnapshot(clientDb, authorization.workspaceId, authorization.authorizationId),
      beforeRejectedClose,
    );
    context.staleRollbackCloseZeroMutation = true;
    const closed = await transition(
      client,
      issued,
      authorization,
      "decision",
      "close_rollback",
      context.state,
      context.sequence,
      context.fence,
      {
        processChecksum: rollbackChecksum,
        heartbeatChecksum: rollbackChecksum,
        projectionChecksum: rollbackChecksum,
        inventoryChecksum: rollbackChecksum,
      },
    );
    context.state = closed.state;
    context.sequence = closed.sequence;
  }
  const finalProviderState = JSON.parse(await readFile(state.path, "utf8"));
  assert.equal(
    Object.keys(finalProviderState.mutations).length,
    Object.values(finalProviderState.counts).reduce((sum, count) => sum + count, 0),
  );
  const canonical = (
    await clientDb.query(
      `SELECT r.state,r.lifecycle_sequence,
        (SELECT count(*)::int FROM mission_agent_v1_provider_mutations m
          WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id) mutation_count,
        (SELECT count(*)::int FROM mission_agent_v1_provider_receipts p
          WHERE p.workspace_id=r.workspace_id AND p.authorization_id=r.authorization_id) receipt_count,
        (SELECT state FROM mission_agent_v1_rollback_obligations o
          WHERE o.workspace_id=r.workspace_id AND o.authorization_id=r.authorization_id) rollback_state
       FROM mission_agent_v1_rollout_operations r
       WHERE r.workspace_id=$1 AND r.authorization_id=$2`,
      [base.workspaceId, authorization.authorizationId],
    )
  ).rows[0];
  assert.equal(canonical.state, rollback ? "rollback_verified" : "success_verified");
  assert.equal(
    canonical.mutation_count,
    rollback ? Object.values(finalProviderState.counts).reduce((sum, count) => sum + count, 0) : 5,
  );
  assert.equal(canonical.mutation_count, canonical.receipt_count);
  assert.equal(canonical.rollback_state, "verified_closed");
  return {
    name,
    ...canonical,
    operationCounts: finalProviderState.counts,
    rejectionResults: context.rejectionResults,
    staleRollbackCloseZeroMutation: context.staleRollbackCloseZeroMutation ?? null,
  };
}

try {
  await run("npm", ["run", "build:v1:operator"]);
  await run("docker", [
    "run",
    "--name",
    container,
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "-e",
    `POSTGRES_DB=${databaseName}`,
    "-p",
    `127.0.0.1:${databasePort}:5432`,
    "-d",
    "postgres:17-alpine",
  ]);
  await waitFor(async () => {
    const result = await run("docker", ["exec", container, "pg_isready", "-U", "postgres"]);
    return result.stdout.includes("accepting connections");
  }, "PostgreSQL");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await run("npm", ["run", "db:migrate"], { DATABASE_URL: databaseUrl });
  database = new pg.Client({ connectionString: databaseUrl });
  database.on("error", () => undefined);
  await database.connect();
  const controllerPassword = randomBytes(24).toString("base64url");
  await database.query(
    `CREATE ROLE mission_control_v1_local_controller LOGIN PASSWORD '${controllerPassword.replaceAll("'", "''")}'`,
  );
  await database.query(`GRANT mission_control_v1_controller TO mission_control_v1_local_controller`);
  const controllerDatabaseUrl =
    `postgresql://mission_control_v1_local_controller:${encodeURIComponent(controllerPassword)}` +
    `@127.0.0.1:${databasePort}/${databaseName}`;
  const base = await seed(database);
  const key = join(root, "tls-key.pem");
  const certificate = join(root, "tls-cert.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
  ]);
  app = spawn(process.execPath, [".next/standalone/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      V1_CONTROLLER_DATABASE_URL: controllerDatabaseUrl,
      MISSION_CONTROL_SESSION_SECRET: randomBytes(32).toString("base64url"),
      PUBLIC_APP_URL: origin,
      HOSTNAME: "127.0.0.1",
      PORT: String(appPort),
      MISSION_CONTROL_V1_PRODUCTION_ROUTES_ENABLED: "true",
      V1_LOCAL_ACCEPTANCE_DIAGNOSTICS: "true",
      ARTIFACT_STORAGE_PROVIDER: "local",
      ARTIFACT_STORAGE_ROOT: join(root, "artifacts"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", (chunk) => {
    appOutput += String(chunk);
  });
  app.stderr.on("data", (chunk) => {
    appOutput += String(chunk);
  });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${appPort}/api/health`)).ok, "production server");
  proxy = spawn(
    process.execPath,
    ["scripts/replacement-disposable-https-proxy.mjs", String(httpsPort), String(appPort), key, certificate],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  await waitFor(async () => (await fetch(`${origin}/api/health`)).ok, "HTTPS proxy");
  const cookie = await login(base.authorization.approvedBy);
  const results = [await scenario(database, cookie, base, "success", 0)];
  for (const prefix of [1, 2, 3, 4, 5])
    results.push(await scenario(database, cookie, base, `rollback-prefix-${prefix}`, prefix));
  const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  const statusLines = (await run("git", ["status", "--porcelain"])).stdout.split("\n").filter(Boolean);
  const changedFiles = {};
  for (const line of statusLines) {
    const path = line.slice(3).replace(/^.* -> /, "");
    if (path.includes("v1-local-production-https-acceptance.json")) continue;
    const paths = (await stat(path)).isDirectory()
      ? (await run("rg", ["--files", path])).stdout.split("\n").filter(Boolean)
      : [path];
    for (const candidate of paths) changedFiles[candidate] = hash(await readFile(candidate));
  }
  const migrationChecksum = hash(await readFile("db/migrations/0030_mission_agent_v1_production_rollout.sql"));
  const operatorArtifactChecksum = JSON.parse(
    await readFile("dist/mission-agent-replacement-operator-v1.json", "utf8"),
  ).sha256;
  const evidence = {
    evidenceVersion: "mission-control-v1-local-production-https-acceptance-v1",
    generatedAt: new Date().toISOString(),
    sourceCommit,
    sourceTreeState: Object.keys(changedFiles).length === 0 ? "clean" : "dirty-acceptance-candidate",
    changedFileChecksums: changedFiles,
    candidateTreeChecksum: hash(canonicalJson(changedFiles)),
    migration0030Checksum: migrationChecksum,
    operatorArtifactChecksum,
    mode: "local-production-mode-standalone-nextjs-over-https",
    database: "PostgreSQL 17, migrations 0001-0030",
    hostOperator: "stateful disposable provider using the production operator protocol and durable journal",
    providerAuthenticatedEcsEvidence: "synthetic local fixture; external ECS staging still required",
    physicalMacOSRehearsal: "not performed; separately authorized staging still required",
    receiptLossBoundary: "forced after every provider mutation before control-plane receipt delivery",
    productionContacted: false,
    namedCanaryContacted: false,
    results,
    rejectionMatrix: {
      handlers: ["claim", "intent", "receipt", "decision", "status", "failure"],
      casesPerHandler: 13,
      canonicalOperationalSnapshotsEqual: true,
      cases: results[0].rejectionResults,
    },
  };
  const output =
    process.env.V1_LOCAL_HTTPS_EVIDENCE_OUTPUT ??
    "release/mission-agent-0.7.2/replacement-bootstrap/evidence/v1-local-production-https-acceptance.json";
  await mkdir(join(output, ".."), { recursive: true });
  const evidenceBytes = `${JSON.stringify(evidence, null, 2)}\n`;
  await writeFile(output, evidenceBytes, { mode: 0o644 });
  await writeFile(`${output}.sha256`, `${hash(evidenceBytes)}  ${output}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ result: "pass", evidence: output, results })}\n`);
} finally {
  for (const child of [proxy, app]) if (child && child.exitCode === null) child.kill("SIGTERM");
  if (database) await database.end().catch(() => undefined);
  await run("docker", ["rm", "-f", container]).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
