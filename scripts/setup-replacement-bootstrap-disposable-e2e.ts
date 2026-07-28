import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  issueReplacementCredentialAndClaim,
  persistIssuedReplacementPackage,
} from "../application/replacement-bootstrap-governance";
import { getDatabasePool, closeDatabasePool } from "../lib/database";
import {
  MISSION_CONTROL_INSTANCE_ID,
  REPLACEMENT_CLAIM_PATH,
  REPLACEMENT_CREDENTIAL_PROTOCOL,
  REPLACEMENT_DECISION_PATH,
  REPLACEMENT_FAILURE_PATH,
  REPLACEMENT_INTENT_PATH,
  REPLACEMENT_PACKAGE_VERSION,
  REPLACEMENT_RECEIPT_PATH,
  REPLACEMENT_STATUS_PATH,
  createReplacementAuthorizationPackage,
} from "../integrations/mission-agent/replacement-authorization-package";
import {
  authorizationChecksum,
  validateReplacementAuthorization,
} from "../integrations/mission-agent/replacement-bootstrap";
import { canonicalJson } from "../integrations/mission-agent/release-authority";
import { deriveSigningKey } from "../remote-agent/protocol";

async function main() {
  const parsed = parseArgs({
    options: {
      output: { type: "string" },
      "mission-control-url": { type: "string" },
      "resource-fingerprint": { type: "string" },
      "execution-id": { type: "string" },
    },
    strict: true,
  });
  if (!parsed.values.output || !parsed.values["mission-control-url"] || !parsed.values["resource-fingerprint"])
    throw new Error("--output, --mission-control-url, and --resource-fingerprint are required.");
  const output = resolve(parsed.values.output);
  const authorization = validateReplacementAuthorization(
    JSON.parse(
      await readFile("release/mission-agent-0.7.2/replacement-bootstrap/simulation-authorization.json", "utf8"),
    ),
  );
  const workspaceId = authorization.workspaceId;
  const executionId = parsed.values["execution-id"] ?? randomUUID();
  const missionId = randomUUID();
  const agentCredentialId = randomUUID();
  const agentCredentialSecret = randomBytes(32).toString("base64url");
  const pool = getDatabasePool();
  await pool.query(
    `CREATE TABLE IF NOT EXISTS replacement_bootstrap_disposable_environment_guard(
      instance_identity text PRIMARY KEY,
      resource_fingerprint text NOT NULL
    )`,
  );
  await pool.query(
    `INSERT INTO replacement_bootstrap_disposable_environment_guard(instance_identity,resource_fingerprint)
     VALUES($1,$2) ON CONFLICT(instance_identity) DO UPDATE SET resource_fingerprint=EXCLUDED.resource_fingerprint`,
    [MISSION_CONTROL_INSTANCE_ID, parsed.values["resource-fingerprint"]],
  );
  await pool.query("INSERT INTO workspaces(id,slug,name) VALUES($1,$2,'Replacement HTTP E2E')", [
    workspaceId,
    `replacement-http-${workspaceId}`,
  ]);
  await pool.query(
    `INSERT INTO agents(
      workspace_id,agent_id,name,adapter_type,capabilities,supported_domains,trust_level,status,
      delivery_mode,mission_agent_version,last_heartbeat_at,pull_ready_at,protocol_versions
    ) VALUES($1,$2,'Disposable named canary','remote_http',$3::jsonb,$4::jsonb,'high','active',
      'pull','0.6.8',clock_timestamp(),clock_timestamp(),'["1.0"]'::jsonb)`,
    [
      workspaceId,
      authorization.agentId,
      JSON.stringify(["repository-analysis", "repository.read"]),
      JSON.stringify(["release-governance"]),
    ],
  );
  await pool.query(
    `INSERT INTO agent_credentials(
      workspace_id,credential_id,agent_id,version,secret_verifier,status,allowed_protocol_versions,
      created_at,verified_at
    ) VALUES($1,$2,$3,1,$4,'active','["1.0"]'::jsonb,clock_timestamp(),clock_timestamp())`,
    [workspaceId, agentCredentialId, authorization.agentId, deriveSigningKey(agentCredentialSecret)],
  );
  await pool.query(
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
  await pool.query(
    `INSERT INTO repository_identities(
      workspace_id,repository_id,identity_version,fingerprint,canonical_remote_url,repository_name,
      selected_remote,created_at,verified_at,verification_source,migration_status
    ) VALUES($1,$2,'legacy-v1',$3,$4,'replacement-smoke-repository','origin',
      clock_timestamp(),clock_timestamp(),'disposable-acceptance','active')`,
    [
      workspaceId,
      authorization.repositoryId,
      authorization.repositoryFingerprint,
      `mission-agent://${authorization.repositoryFingerprint}`,
    ],
  );
  await pool.query(
    `INSERT INTO agent_resource_permissions(
      workspace_id,agent_id,resource_type,resource_id,permissions
    ) VALUES($1,$2,'repository',$3,'["read"]'::jsonb)`,
    [workspaceId, authorization.agentId, authorization.repositoryId],
  );
  await pool.query(
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
  await pool.query(
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
  const client = await pool.connect();
  let issued;
  try {
    issued = await issueReplacementCredentialAndClaim({
      client,
      authorization,
      executionId,
      authenticatedApprover: authorization.approvedBy,
    });
  } finally {
    client.release();
  }
  const pkg = createReplacementAuthorizationPackage({
    credentialSigningKey: deriveSigningKey(issued.secret),
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
  const packageClient = await pool.connect();
  try {
    await persistIssuedReplacementPackage({ client: packageClient, pkg });
  } finally {
    packageClient.release();
  }
  await writeFile(`${output}.package.json`, `${canonicalJson(pkg)}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(`${output}.replacement-secret`, `${issued.secret}\n`, { mode: 0o600, flag: "wx" });
  await writeFile(
    `${output}.agent-fixture.json`,
    `${canonicalJson({
      missionControlUrl: parsed.values["mission-control-url"],
      workspaceId,
      agentId: authorization.agentId,
      credentialId: agentCredentialId,
      credentialSecret: agentCredentialSecret,
    })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await writeFile(
    `${output}.summary.json`,
    `${canonicalJson({
      workspaceId,
      authorizationId: authorization.authorizationId,
      executionId,
      agentId: authorization.agentId,
      artifactSha256: authorization.targetArtifactSha256,
    })}\n`,
    { mode: 0o600, flag: "wx" },
  );
  await closeDatabasePool();
}

void main();
