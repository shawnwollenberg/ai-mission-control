ALTER TABLE agents
  ADD COLUMN provider_id text NOT NULL DEFAULT 'generic'
    CHECK(provider_id IN('codex','claude_code','hermes','generic','mock')),
  ADD COLUMN agent_version text,
  ADD COLUMN supported_mission_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN supported_operations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN supported_models jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN model_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN capability_attestation_id uuid,
  ADD COLUMN capability_attestation_hash text
    CHECK(capability_attestation_hash IS NULL OR capability_attestation_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN capability_attestation_version integer
    CHECK(capability_attestation_version IS NULL OR capability_attestation_version > 0),
  ADD COLUMN capability_source text
    CHECK(capability_source IS NULL OR capability_source IN('provider_discovery','operator_allowlist','hybrid')),
  ADD COLUMN capability_attested_at timestamptz,
  ADD COLUMN capability_attestation_expires_at timestamptz,
  ADD COLUMN provider_credentials_available boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_runtime_requirements_id text,
  ADD COLUMN provider_runtime_requirements_hash text
    CHECK(provider_runtime_requirements_hash IS NULL OR provider_runtime_requirements_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN provider_runtime_status jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN provider_runtime_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN provider_runtime_requirements_satisfied boolean NOT NULL DEFAULT false,
  ADD COLUMN structured_output boolean NOT NULL DEFAULT false,
  ADD COLUMN project_brain_context boolean NOT NULL DEFAULT false,
  ADD COLUMN repository_mutation boolean NOT NULL DEFAULT false;

ALTER TABLE agents
  ADD COLUMN mission_agent_runtime_mode text
    CHECK(mission_agent_runtime_mode IS NULL OR mission_agent_runtime_mode IN('local','test','production','disposable_acceptance')),
  ADD COLUMN mission_agent_trust_authority text,
  ADD COLUMN mission_agent_acceptance_registry_path text,
  ADD COLUMN mission_agent_acceptance_registry_path_hash text
    CHECK(mission_agent_acceptance_registry_path_hash IS NULL OR mission_agent_acceptance_registry_path_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN mission_agent_acceptance_registry_hash text
    CHECK(mission_agent_acceptance_registry_hash IS NULL OR mission_agent_acceptance_registry_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN mission_agent_disposable_packet jsonb;

ALTER TABLE repositories
  ADD COLUMN repository_state jsonb,
  ADD COLUMN repository_snapshot_hash text
    CHECK(repository_snapshot_hash IS NULL OR repository_snapshot_hash ~ '^[0-9a-f]{64}$');

CREATE TABLE repository_snapshot_artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_artifact_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  schema_version text NOT NULL CHECK(schema_version IN('complete_repository_state/2','complete_repository_state/3')),
  checksum_sha256 text NOT NULL CHECK(checksum_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size bigint NOT NULL CHECK(byte_size > 0 AND byte_size <= 262144),
  manifest jsonb NOT NULL,
  registration_event_id uuid NOT NULL,
  registration_actor_agent_id uuid NOT NULL,
  registration_authority jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,snapshot_artifact_id),
  UNIQUE(workspace_id,repository_id,checksum_sha256)
);

CREATE FUNCTION prevent_repository_snapshot_artifact_update() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'repository snapshot artifacts are immutable';
END $$;
CREATE TRIGGER repository_snapshot_artifacts_immutable
BEFORE UPDATE ON repository_snapshot_artifacts
FOR EACH ROW EXECUTE FUNCTION prevent_repository_snapshot_artifact_update();

ALTER TABLE repositories
  ADD COLUMN repository_snapshot_artifact_id uuid,
  ADD CONSTRAINT repository_snapshot_artifact_fk
    FOREIGN KEY(workspace_id,repository_snapshot_artifact_id)
    REFERENCES repository_snapshot_artifacts(workspace_id,snapshot_artifact_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE agent_model_capability_attestations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability_attestation_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider_id text NOT NULL CHECK(provider_id IN('codex','claude_code','hermes','generic','mock')),
  agent_version text NOT NULL,
  mission_agent_artifact_checksum text CHECK(
    mission_agent_artifact_checksum IS NULL OR mission_agent_artifact_checksum ~ '^[0-9a-f]{64}$'
  ),
  attestation_version integer NOT NULL CHECK(attestation_version > 0),
  capability_source text NOT NULL CHECK(capability_source IN('provider_discovery','operator_allowlist','hybrid')),
  supported_models jsonb NOT NULL,
  model_capabilities jsonb NOT NULL,
  provider_runtime_requirements_id text NOT NULL,
  provider_runtime_requirements_hash text NOT NULL CHECK(provider_runtime_requirements_hash ~ '^[0-9a-f]{64}$'),
  provider_runtime_profiles jsonb NOT NULL DEFAULT '[]'::jsonb,
  runtime_mode text,
  trust_authority text,
  acceptance_registry_path text,
  acceptance_registry_path_hash text CHECK(
    acceptance_registry_path_hash IS NULL OR acceptance_registry_path_hash ~ '^[0-9a-f]{64}$'
  ),
  acceptance_registry_hash text CHECK(
    acceptance_registry_hash IS NULL OR acceptance_registry_hash ~ '^[0-9a-f]{64}$'
  ),
  disposable_packet jsonb,
  attestation_hash text NOT NULL CHECK(attestation_hash ~ '^[0-9a-f]{64}$'),
  advertised_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,capability_attestation_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE CASCADE
);

ALTER TABLE agents ADD CONSTRAINT agents_capability_attestation_fk
  FOREIGN KEY(workspace_id,capability_attestation_id)
  REFERENCES agent_model_capability_attestations(workspace_id,capability_attestation_id)
  ON DELETE SET NULL (capability_attestation_id);

UPDATE agents
SET provider_id=CASE
  WHEN mission_agent_adapter='claude-code' THEN 'claude_code'
  WHEN mission_agent_adapter='hermes' THEN 'hermes'
  WHEN mission_agent_adapter='codex' OR adapter_type='codex' THEN 'codex'
  WHEN adapter_type='mock' THEN 'mock'
  ELSE 'generic'
END,
agent_version=COALESCE(mission_agent_version,agent_version);

ALTER TABLE mission_projections
  ADD COLUMN mission_type text NOT NULL DEFAULT 'standard'
    CHECK(mission_type IN('standard','repository_analysis','repository_change','consensus_plan')),
  ADD COLUMN repository_id uuid,
  ADD COLUMN base_branch text,
  ADD COLUMN base_commit text CHECK(base_commit IS NULL OR base_commit ~ '^[0-9a-f]{40,64}$'),
  ADD COLUMN repository_snapshot text CHECK(repository_snapshot IS NULL OR repository_snapshot ~ '^[0-9a-f]{64}$'),
  ADD COLUMN parent_consensus_mission_id uuid,
  ADD COLUMN approved_plan_artifact_id uuid,
  ADD COLUMN approved_plan_hash text CHECK(approved_plan_hash IS NULL OR approved_plan_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT mission_projection_repository_fk
    FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id),
  ADD CONSTRAINT mission_projection_approved_plan_fk
    FOREIGN KEY(workspace_id,approved_plan_artifact_id) REFERENCES artifacts(workspace_id,artifact_id);

CREATE UNIQUE INDEX one_child_implementation_per_consensus
  ON mission_projections(workspace_id,parent_consensus_mission_id)
  WHERE parent_consensus_mission_id IS NOT NULL;

ALTER TABLE pull_assignments
  ADD COLUMN fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token >= 0),
  ADD COLUMN lease_receipt_id uuid,
  ADD COLUMN lease_token_fingerprint text CHECK(lease_token_fingerprint IS NULL OR lease_token_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN output_fenced_at timestamptz,
  ADD COLUMN output_fence_reason text;

CREATE TABLE consensus_plan_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK(aggregate_version > 0),
  status text NOT NULL CHECK(status IN(
    'draft','ready','capturing_independent_proposals','proposals_complete','critique_round','revision_round',
    'canonicalization','awaiting_final_verdicts','consensus_reached','consensus_not_reached',
    'awaiting_human_approval','approved','rejected','implementation_mission_created','completed','failed','cancelled'
  )),
  consensus_attempt integer NOT NULL DEFAULT 1 CHECK(consensus_attempt > 0),
  repository_id uuid NOT NULL,
  base_branch text NOT NULL,
  repository_snapshot text NOT NULL CHECK(repository_snapshot ~ '^[0-9a-f]{64}$'),
  repository_base_commit text NOT NULL CHECK(repository_base_commit ~ '^[0-9a-f]{40,64}$'),
  project_brain_context_artifact_id uuid,
  context_pack_hash text CHECK(context_pack_hash IS NULL OR context_pack_hash ~ '^[0-9a-f]{64}$'),
  planning_schema_version text NOT NULL,
  synthesizer_assignment_id uuid NOT NULL,
  preferred_executor_agent_id uuid,
  preferred_executor_model_id text,
  execution_budget jsonb NOT NULL,
  require_implementation_review boolean NOT NULL DEFAULT false,
  maximum_rounds integer NOT NULL DEFAULT 1 CHECK(maximum_rounds=1),
  maximum_turns integer NOT NULL DEFAULT 10 CHECK(maximum_turns BETWEEN 10 AND 32),
  maximum_duration_seconds integer NOT NULL CHECK(maximum_duration_seconds BETWEEN 60 AND 86400),
  maximum_cost_amount numeric CHECK(maximum_cost_amount IS NULL OR maximum_cost_amount >= 0),
  cost_currency text NOT NULL DEFAULT 'USD',
  maximum_artifact_bytes integer NOT NULL DEFAULT 131072 CHECK(maximum_artifact_bytes BETWEEN 1024 AND 131072),
  maximum_command_count integer NOT NULL DEFAULT 100 CHECK(maximum_command_count BETWEEN 1 AND 1000),
  maximum_retry_count integer NOT NULL DEFAULT 2 CHECK(maximum_retry_count BETWEEN 0 AND 10),
  started_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  canonical_plan_artifact_id uuid,
  canonical_plan_hash text CHECK(canonical_plan_hash IS NULL OR canonical_plan_hash ~ '^[0-9a-f]{64}$'),
  canonical_plan_schema_version text,
  consensus_decision text CHECK(consensus_decision IS NULL OR consensus_decision IN('reached','not_reached')),
  human_approval_id uuid,
  implementation_mission_id uuid,
  learning_candidate_artifact_id uuid,
  learning_candidate_status text CHECK(learning_candidate_status IS NULL OR learning_candidate_status IN('proposed','reviewed','rejected','promoted')),
  stale_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,mission_id),
  FOREIGN KEY(workspace_id,mission_id) REFERENCES mission_projections(workspace_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id),
  FOREIGN KEY(workspace_id,preferred_executor_agent_id) REFERENCES agents(workspace_id,agent_id),
  FOREIGN KEY(workspace_id,project_brain_context_artifact_id) REFERENCES artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,canonical_plan_artifact_id) REFERENCES artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,human_approval_id) REFERENCES approval_projections(workspace_id,approval_id),
  FOREIGN KEY(workspace_id,implementation_mission_id) REFERENCES mission_projections(workspace_id,mission_id),
  FOREIGN KEY(workspace_id,learning_candidate_artifact_id) REFERENCES artifacts(workspace_id,artifact_id)
);

CREATE TABLE consensus_participant_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  participant_assignment_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  role text NOT NULL CHECK(role IN('planner_a','planner_b','synthesizer','executor','implementation_reviewer')),
  agent_id uuid NOT NULL,
  provider_id text NOT NULL CHECK(provider_id IN('codex','claude_code','hermes','generic','mock')),
  model_id text NOT NULL,
  capability_attestation_id uuid NOT NULL,
  capability_attestation_hash text NOT NULL CHECK(capability_attestation_hash ~ '^[0-9a-f]{64}$'),
  permission_profile_hash text NOT NULL CHECK(permission_profile_hash ~ '^[0-9a-f]{64}$'),
  required_operations jsonb NOT NULL,
  runtime_model_identity text NOT NULL CHECK(runtime_model_identity IN('verified','reported','unverifiable')),
  provider_runtime_requirements_id text NOT NULL,
  provider_runtime_requirements_hash text NOT NULL CHECK(provider_runtime_requirements_hash ~ '^[0-9a-f]{64}$'),
  assigned_at timestamptz NOT NULL,
  assignment_version integer NOT NULL DEFAULT 1 CHECK(assignment_version > 0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,participant_assignment_id),
  UNIQUE(workspace_id,mission_id,role),
  FOREIGN KEY(workspace_id,mission_id) REFERENCES consensus_plan_projections(workspace_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id),
  FOREIGN KEY(workspace_id,capability_attestation_id)
    REFERENCES agent_model_capability_attestations(workspace_id,capability_attestation_id)
);

CREATE TABLE consensus_turns (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  turn_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  participant_assignment_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN('prepare_context','proposal','critique','revision','canonicalize','verdict')),
  round integer NOT NULL DEFAULT 1 CHECK(round > 0),
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  source_artifact_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','completed','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(workspace_id,turn_id),
  UNIQUE(workspace_id,mission_id,participant_assignment_id,operation,round),
  UNIQUE(workspace_id,task_id),
  UNIQUE(workspace_id,execution_id),
  FOREIGN KEY(workspace_id,mission_id) REFERENCES consensus_plan_projections(workspace_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,participant_assignment_id) REFERENCES consensus_participant_assignments(workspace_id,participant_assignment_id),
  FOREIGN KEY(workspace_id,task_id) REFERENCES task_projections(workspace_id,task_id),
  FOREIGN KEY(workspace_id,execution_id) REFERENCES execution_projections(workspace_id,execution_id)
);

CREATE TABLE consensus_artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  participant_assignment_id uuid,
  turn_id uuid,
  artifact_kind text NOT NULL CHECK(artifact_kind IN(
    'project_brain_context_pack','consensus_proposal','consensus_critique','consensus_revision',
    'canonical_implementation_plan','canonical_plan_verdict'
  )),
  schema_version text NOT NULL,
  round integer NOT NULL DEFAULT 1 CHECK(round > 0),
  repository_snapshot text NOT NULL CHECK(repository_snapshot ~ '^[0-9a-f]{64}$'),
  context_pack_hash text CHECK(context_pack_hash IS NULL OR context_pack_hash ~ '^[0-9a-f]{64}$'),
  reviewed_artifact_id uuid,
  revises_proposal_artifact_id uuid,
  prior_revision_artifact_id uuid,
  canonical_plan_hash text CHECK(canonical_plan_hash IS NULL OR canonical_plan_hash ~ '^[0-9a-f]{64}$'),
  verdict text,
  blocking_objection_count integer NOT NULL DEFAULT 0 CHECK(blocking_objection_count >= 0),
  artifact_checksum text NOT NULL CHECK(artifact_checksum ~ '^[0-9a-f]{64}$'),
  normalized_payload jsonb,
  immutable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,artifact_id) REFERENCES artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,mission_id) REFERENCES consensus_plan_projections(workspace_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,participant_assignment_id) REFERENCES consensus_participant_assignments(workspace_id,participant_assignment_id),
  FOREIGN KEY(workspace_id,turn_id) REFERENCES consensus_turns(workspace_id,turn_id),
  FOREIGN KEY(workspace_id,reviewed_artifact_id) REFERENCES consensus_artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,revises_proposal_artifact_id) REFERENCES consensus_artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,prior_revision_artifact_id) REFERENCES consensus_artifacts(workspace_id,artifact_id)
);

CREATE UNIQUE INDEX one_context_pack_per_consensus
  ON consensus_artifacts(workspace_id,mission_id)
  WHERE artifact_kind='project_brain_context_pack';
CREATE UNIQUE INDEX one_canonical_plan_per_consensus
  ON consensus_artifacts(workspace_id,mission_id)
  WHERE artifact_kind='canonical_implementation_plan';
CREATE UNIQUE INDEX one_consensus_artifact_per_turn
  ON consensus_artifacts(workspace_id,turn_id,artifact_kind)
  WHERE turn_id IS NOT NULL;

CREATE FUNCTION prevent_consensus_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consensus artifacts are immutable';
END $$;
CREATE TRIGGER consensus_artifact_immutable
  BEFORE UPDATE ON consensus_artifacts FOR EACH ROW EXECUTE FUNCTION prevent_consensus_artifact_update();
CREATE UNIQUE INDEX one_verdict_per_assignment_and_hash
  ON consensus_artifacts(workspace_id,participant_assignment_id,canonical_plan_hash)
  WHERE artifact_kind='canonical_plan_verdict';

CREATE TABLE consensus_objections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id uuid NOT NULL,
  objection_id uuid NOT NULL,
  raw_provider_objection_id text NOT NULL,
  consensus_attempt integer NOT NULL CHECK(consensus_attempt > 0),
  source_artifact_id uuid NOT NULL,
  participant_assignment_id uuid NOT NULL,
  round integer NOT NULL CHECK(round > 0),
  category text NOT NULL CHECK(category IN('correctness','security','data','operations','testing','scope','assumption','other')),
  description text NOT NULL,
  required_change text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved','superseded')),
  resolved_by_artifact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY(workspace_id,mission_id,objection_id),
  FOREIGN KEY(workspace_id,mission_id) REFERENCES consensus_plan_projections(workspace_id,mission_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,source_artifact_id) REFERENCES consensus_artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,participant_assignment_id) REFERENCES consensus_participant_assignments(workspace_id,participant_assignment_id),
  FOREIGN KEY(workspace_id,resolved_by_artifact_id) REFERENCES consensus_artifacts(workspace_id,artifact_id)
);
CREATE UNIQUE INDEX consensus_objection_source_provenance_unique
  ON consensus_objections(workspace_id,mission_id,consensus_attempt,source_artifact_id,participant_assignment_id,round,raw_provider_objection_id);

CREATE OR REPLACE FUNCTION agent_protocol_receipt_v2_is_valid(receipt jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  top_keys text[];
  lease_receipt jsonb;
  binding jsonb;
  runtime_trust jsonb;
BEGIN
  IF jsonb_typeof(receipt) <> 'object'
     OR receipt->>'schemaVersion' <> 'agent-protocol-receipt/2'
     OR receipt->>'protocolVersion' <> '1.0'
     OR COALESCE(receipt->>'messageId','') = ''
     OR receipt::text ~* '(mc_(pb_)?lease_[A-Za-z0-9_-]{20,}|Bearer[[:space:]]+[A-Za-z0-9._~+/-]{20,})'
  THEN RETURN false; END IF;
  SELECT array_agg(key ORDER BY key) INTO top_keys FROM jsonb_object_keys(receipt) key;
  IF receipt->>'status' = 'processing' THEN
    IF NOT (top_keys = ARRAY['messageId','protocolVersion','schemaVersion','status']
      OR top_keys = ARRAY['messageId','protocolVersion','runtimeTrust','schemaVersion','status'])
    THEN RETURN false; END IF;
  ELSE
    IF receipt->>'status' <> 'completed'
       OR COALESCE(receipt->>'responseChecksum','') !~ '^[a-f0-9]{64}$'
       OR NOT (top_keys <@ ARRAY['authorization','messageId','protocolVersion','responseChecksum','runtimeTrust','schemaVersion','status'])
       OR NOT (ARRAY['messageId','protocolVersion','responseChecksum','schemaVersion','status'] <@ top_keys)
    THEN RETURN false; END IF;
  END IF;
  IF receipt ? 'runtimeTrust' THEN
    runtime_trust := receipt->'runtimeTrust';
    IF jsonb_typeof(runtime_trust) <> 'object'
       OR NOT (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(runtime_trust) key)
         = ARRAY['disposable','registryContentHash','registryPath','registryPathHash','registryScope','registryVersion','runtimeMode','schemaVersion','trustAuthority']
       OR runtime_trust->>'schemaVersion' <> 'mission-control-runtime-trust/1'
       OR runtime_trust->>'runtimeMode' <> 'disposable_acceptance'
       OR runtime_trust->'disposable' <> 'true'::jsonb
       OR COALESCE(runtime_trust->>'registryPath','') = ''
       OR COALESCE(runtime_trust->>'registryPathHash','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(runtime_trust->>'registryContentHash','') !~ '^[a-f0-9]{64}$'
       OR NOT (
         (
           runtime_trust->>'trustAuthority' = 'disposable_exact_checksum_registry'
           AND runtime_trust->>'registryVersion' = 'mission-agent-disposable-acceptance/2'
           AND runtime_trust->>'registryScope' = 'consensus_real_provider_acceptance'
         )
         OR (
           runtime_trust->>'trustAuthority' = 'non_authenticated_candidate_validation'
           AND runtime_trust->>'registryVersion' = 'mission-agent-non-authenticated-candidate-validation/1'
           AND runtime_trust->>'registryScope' = 'non_authenticated_candidate_validation'
         )
       )
    THEN RETURN false; END IF;
  END IF;
  IF receipt->>'status' = 'processing' THEN RETURN true; END IF;
  IF NOT receipt ? 'authorization' THEN RETURN true; END IF;
  lease_receipt := receipt->'authorization';
  IF jsonb_typeof(lease_receipt) <> 'object'
     OR lease_receipt->>'schemaVersion' <> 'lease-authorization-receipt/1'
     OR lease_receipt->>'kind' NOT IN ('execution_assignment','project_brain_assignment')
     OR COALESCE(lease_receipt->>'leaseId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(lease_receipt->>'tokenFingerprint','') !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(lease_receipt->'issuedAt') <> 'string'
     OR jsonb_typeof(lease_receipt->'expiresAt') <> 'string'
     OR jsonb_typeof(lease_receipt->'fencingToken') NOT IN ('number','null')
     OR NOT (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lease_receipt) key)
       = ARRAY['binding','expiresAt','fencingToken','issuedAt','kind','leaseId','schemaVersion','tokenFingerprint']
  THEN RETURN false; END IF;
  binding := lease_receipt->'binding';
  IF jsonb_typeof(binding) <> 'object'
     OR NOT (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(binding) key)
       = ARRAY['agentId','assignmentId','credentialId','executionId','leaseOwner','operationId','workspaceId']
     OR COALESCE(binding->>'workspaceId','') = ''
     OR COALESCE(binding->>'agentId','') = ''
     OR COALESCE(binding->>'credentialId','') = ''
     OR COALESCE(binding->>'assignmentId','') = ''
     OR COALESCE(binding->>'leaseOwner','') = ''
     OR COALESCE(binding->>'workspaceId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(binding->>'agentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(binding->>'credentialId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR COALESCE(binding->>'assignmentId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR (binding->'executionId' <> 'null'::jsonb AND COALESCE(binding->>'executionId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR (binding->'operationId' <> 'null'::jsonb AND COALESCE(binding->>'operationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
     OR (lease_receipt->>'kind' = 'execution_assignment' AND binding->'executionId' = 'null'::jsonb)
     OR (lease_receipt->>'kind' = 'project_brain_assignment' AND binding->'operationId' = 'null'::jsonb)
  THEN RETURN false; END IF;
  BEGIN
    IF (lease_receipt->>'issuedAt')::timestamptz >= (lease_receipt->>'expiresAt')::timestamptz
       OR (
         lease_receipt->'fencingToken' <> 'null'::jsonb
         AND (
           (lease_receipt->>'fencingToken')::numeric < 0
           OR (lease_receipt->>'fencingToken')::numeric <> trunc((lease_receipt->>'fencingToken')::numeric)
         )
       )
    THEN RETURN false; END IF;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  RETURN true;
END $$;

ALTER TABLE agent_protocol_receipts
  ADD CONSTRAINT agent_protocol_receipt_v2_structure_check
  CHECK (agent_protocol_receipt_v2_is_valid(acknowledgement)
    AND acknowledgement->>'messageId'=message_id::text) NOT VALID;

-- Protocol receipts are bounded, non-authoritative idempotency records. An
-- upgrade must be performed after protocol traffic is drained: fail closed
-- while any unexpired legacy receipt remains, remove only expired invalid
-- receipts, and then make the structural no-secret rule valid for every row.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_protocol_receipts
    WHERE NOT (
      agent_protocol_receipt_v2_is_valid(acknowledgement)
      AND acknowledgement->>'messageId'=message_id::text
    )
      AND expires_at > now()
  ) THEN
    RAISE EXCEPTION 'migration 0029 requires all legacy protocol receipts to expire after protocol traffic is drained';
  END IF;
END $$;

DELETE FROM agent_protocol_receipts
WHERE NOT (
  agent_protocol_receipt_v2_is_valid(acknowledgement)
  AND acknowledgement->>'messageId'=message_id::text
);

ALTER TABLE agent_protocol_receipts
  VALIDATE CONSTRAINT agent_protocol_receipt_v2_structure_check;

ALTER TABLE usage_records
  ADD COLUMN participant_assignment_id uuid,
  ADD COLUMN assignment_role text,
  ADD COLUMN planning_phase text,
  ADD COLUMN execution_attempt integer;

CREATE TABLE consensus_execution_validation_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  validation_receipt_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  parent_consensus_mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  execution_attempt integer NOT NULL CHECK(execution_attempt > 0),
  participant_assignment_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider_id text NOT NULL CHECK(provider_id IN('codex','claude_code','hermes','generic','mock')),
  model_id text NOT NULL,
  capability_attestation_id uuid NOT NULL,
  capability_attestation_hash text NOT NULL CHECK(capability_attestation_hash ~ '^[0-9a-f]{64}$'),
  permission_profile_hash text NOT NULL CHECK(permission_profile_hash ~ '^[0-9a-f]{64}$'),
  base_commit text NOT NULL CHECK(base_commit ~ '^[0-9a-f]{40,64}$'),
  result_commit text NOT NULL CHECK(result_commit ~ '^[0-9a-f]{40,64}$'),
  canonical_plan_hash text NOT NULL CHECK(canonical_plan_hash ~ '^[0-9a-f]{64}$'),
  patch_artifact_id uuid NOT NULL,
  patch_checksum text NOT NULL CHECK(patch_checksum ~ '^[0-9a-f]{64}$'),
  validation_artifact_id uuid NOT NULL,
  validation_checksum text NOT NULL CHECK(validation_checksum ~ '^[0-9a-f]{64}$'),
  summary_artifact_id uuid NOT NULL,
  summary_checksum text NOT NULL CHECK(summary_checksum ~ '^[0-9a-f]{64}$'),
  validation_command_identities jsonb NOT NULL,
  completed_at timestamptz NOT NULL,
  lease_owner text NOT NULL,
  fencing_token bigint NOT NULL CHECK(fencing_token >= 0),
  provenance_message_id uuid NOT NULL,
  runtime_model_identity text NOT NULL CHECK(runtime_model_identity IN('verified','reported','unverifiable')),
  requested_model_id text NOT NULL,
  actual_model_id text,
  execution_authority_presentation jsonb NOT NULL,
  execution_authority_presentation_sha256 text NOT NULL CHECK(execution_authority_presentation_sha256 ~ '^[0-9a-f]{64}$'),
  receipt_hash text NOT NULL CHECK(receipt_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,validation_receipt_id),
  UNIQUE(workspace_id,execution_id,execution_attempt),
  -- Mission, execution, and participant projections are deliberately omitted
  -- as foreign keys: this immutable receipt must survive empty-state replay of
  -- those derived tables. The application validates every binding before insert.
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id),
  FOREIGN KEY(workspace_id,capability_attestation_id)
    REFERENCES agent_model_capability_attestations(workspace_id,capability_attestation_id),
  FOREIGN KEY(workspace_id,patch_artifact_id) REFERENCES artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,validation_artifact_id) REFERENCES artifacts(workspace_id,artifact_id),
  FOREIGN KEY(workspace_id,summary_artifact_id) REFERENCES artifacts(workspace_id,artifact_id)
);

CREATE FUNCTION prevent_consensus_validation_receipt_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consensus validation receipts are immutable';
END $$;
CREATE TRIGGER consensus_validation_receipt_immutable
  BEFORE UPDATE ON consensus_execution_validation_receipts FOR EACH ROW
  EXECUTE FUNCTION prevent_consensus_validation_receipt_update();

CREATE TABLE provider_runtime_diagnostics (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  diagnostic_id uuid NOT NULL,
  diagnostic_schema_version text NOT NULL CHECK(diagnostic_schema_version='provider-runtime-diagnostic/1'),
  mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  execution_attempt integer NOT NULL CHECK(execution_attempt > 0),
  assignment_id uuid NOT NULL,
  participant_assignment_id uuid,
  role text,
  agent_id uuid NOT NULL,
  provider_id text NOT NULL CHECK(provider_id IN('codex','claude_code')),
  requested_model_id text NOT NULL,
  cli_version text NOT NULL,
  runtime_profile_id text NOT NULL,
  runtime_profile_hash text NOT NULL CHECK(runtime_profile_hash ~ '^[0-9a-f]{64}$'),
  sandbox_profile_hash text NOT NULL CHECK(sandbox_profile_hash ~ '^[0-9a-f]{64}$'),
  provider_attempt_id text NOT NULL,
  lease_owner text NOT NULL,
  fencing_token bigint NOT NULL CHECK(fencing_token >= 0),
  process_started_at timestamptz NOT NULL,
  process_terminated_at timestamptz NOT NULL,
  exit_code integer,
  termination_signal text,
  timed_out boolean NOT NULL,
  cancellation_requested boolean NOT NULL,
  stdout_hash text NOT NULL CHECK(stdout_hash ~ '^[0-9a-f]{64}$'),
  stderr_hash text NOT NULL CHECK(stderr_hash ~ '^[0-9a-f]{64}$'),
  stdout_excerpt text,
  stderr_excerpt text,
  text_available boolean NOT NULL,
  failed_initialization_phase text NOT NULL,
  child_process jsonb NOT NULL,
  sandbox_denial jsonb NOT NULL,
  temporary_directory_identity text NOT NULL CHECK(temporary_directory_identity ~ '^[0-9a-f]{64}$'),
  working_directory_identity text NOT NULL CHECK(working_directory_identity ~ '^[0-9a-f]{64}$'),
  environment_variable_names jsonb NOT NULL,
  local_secret_scan text NOT NULL CHECK(local_secret_scan IN('passed_exact_and_pattern','text_unavailable')),
  server_secret_scan text NOT NULL CHECK(server_secret_scan IN('passed','text_removed')),
  diagnostic_hash text NOT NULL CHECK(diagnostic_hash ~ '^[0-9a-f]{64}$'),
  provenance_message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,diagnostic_id),
  UNIQUE(workspace_id,execution_id,execution_attempt,provider_attempt_id),
  -- Execution, assignment, and participant rows are replayable/operational.
  -- Diagnostics are immutable evidence and retain their validated identifiers
  -- while those derived rows are deleted and reconstructed.
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id)
);

CREATE FUNCTION prevent_provider_runtime_diagnostic_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider runtime diagnostics are immutable';
END $$;
CREATE TRIGGER provider_runtime_diagnostic_immutable
  BEFORE UPDATE ON provider_runtime_diagnostics FOR EACH ROW
  EXECUTE FUNCTION prevent_provider_runtime_diagnostic_update();

CREATE INDEX provider_runtime_diagnostics_execution_idx
  ON provider_runtime_diagnostics(workspace_id,execution_id,execution_attempt,created_at);

CREATE INDEX consensus_status_idx ON consensus_plan_projections(workspace_id,status,updated_at);
CREATE INDEX consensus_turn_status_idx ON consensus_turns(workspace_id,mission_id,status,operation);
CREATE INDEX consensus_artifact_history_idx ON consensus_artifacts(workspace_id,mission_id,created_at);
