CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mission_control_v1_controller') THEN
    CREATE ROLE mission_control_v1_controller NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mission_control_v1_verifier') THEN
    CREATE ROLE mission_control_v1_verifier NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='mission_control_v1_runtime') THEN
    CREATE ROLE mission_control_v1_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN (
       'mission_control_v1_controller','mission_control_v1_verifier','mission_control_v1_runtime'
     )
       AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolinherit)
  ) THEN
    RAISE EXCEPTION 'pre-existing Mission Control v1 capability role has unsafe attributes';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
      JOIN pg_roles capability_role
        ON capability_role.oid=membership.roleid OR capability_role.oid=membership.member
     WHERE capability_role.rolname IN (
       'mission_control_v1_controller','mission_control_v1_verifier','mission_control_v1_runtime'
     )
  ) THEN
    RAISE EXCEPTION 'pre-existing Mission Control v1 capability role has unauthorized members';
  END IF;
END $$;

CREATE TABLE mission_control_production_deployments (
  deployment_id uuid PRIMARY KEY,
  environment text NOT NULL CHECK(environment = 'production'),
  aws_account_id text NOT NULL CHECK(aws_account_id ~ '^[0-9]{12}$'),
  aws_region text NOT NULL,
  ecs_cluster_arn text NOT NULL,
  ecs_service_arn text NOT NULL,
  ecs_deployment_id text NOT NULL,
  task_definition_arn text NOT NULL,
  task_arn text NOT NULL,
  ecr_repository_arn text NOT NULL,
  image_digest text NOT NULL CHECK(image_digest ~ '^sha256:[a-f0-9]{64}$'),
  task_role_arn text NOT NULL,
  execution_role_arn text NOT NULL,
  application_commit text NOT NULL CHECK(application_commit ~ '^[a-f0-9]{40}$'),
  build_identity_checksum text NOT NULL CHECK(build_identity_checksum ~ '^[a-f0-9]{64}$'),
  configuration_checksum text NOT NULL CHECK(configuration_checksum ~ '^[a-f0-9]{64}$'),
  database_identity_checksum text NOT NULL CHECK(database_identity_checksum ~ '^[a-f0-9]{64}$'),
  attestation_checksum text NOT NULL UNIQUE CHECK(attestation_checksum ~ '^[a-f0-9]{64}$'),
  attestation_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE mission_control_v1_production_configurations (
  configuration_id uuid PRIMARY KEY,
  deployment_id uuid NOT NULL REFERENCES mission_control_production_deployments(deployment_id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK(version > 0),
  predecessor_id uuid REFERENCES mission_control_v1_production_configurations(configuration_id) ON DELETE RESTRICT,
  configuration_checksum text NOT NULL UNIQUE CHECK(configuration_checksum ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN (
    'disabled','read_only_preflight','migration_ready','canary_authorized',
    'forward_active','recovery_only','terminal_disabled'
  )),
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(deployment_id,configuration_id),
  UNIQUE(deployment_id,version),
  CHECK((version = 1 AND predecessor_id IS NULL) OR (version > 1 AND predecessor_id IS NOT NULL))
);

CREATE OR REPLACE FUNCTION validate_v1_configuration_successor()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.deployment_id::text,0));
  IF NEW.version = 1 THEN
    IF NEW.state <> 'disabled' THEN
      RAISE EXCEPTION 'first v1 configuration must be disabled';
    END IF;
    RETURN NEW;
  END IF;
  SELECT deployment_id,version,state INTO predecessor
    FROM mission_control_v1_production_configurations
   WHERE configuration_id=NEW.predecessor_id;
  IF predecessor IS NULL
     OR predecessor.deployment_id <> NEW.deployment_id
     OR predecessor.version + 1 <> NEW.version THEN
    RAISE EXCEPTION 'invalid v1 configuration predecessor';
  END IF;
  IF NOT (
    (predecessor.state='disabled' AND NEW.state IN ('read_only_preflight','terminal_disabled')) OR
    (predecessor.state='read_only_preflight' AND NEW.state IN ('migration_ready','disabled','terminal_disabled')) OR
    (predecessor.state='migration_ready' AND NEW.state IN ('canary_authorized','disabled','terminal_disabled')) OR
    (predecessor.state='canary_authorized' AND NEW.state IN ('forward_active','disabled','terminal_disabled')) OR
    (predecessor.state='forward_active' AND NEW.state IN ('recovery_only','terminal_disabled')) OR
    (predecessor.state='recovery_only' AND NEW.state='terminal_disabled')
  ) THEN
    RAISE EXCEPTION 'invalid v1 configuration transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_control_v1_configuration_successor_guard
BEFORE INSERT ON mission_control_v1_production_configurations
FOR EACH ROW EXECUTE FUNCTION validate_v1_configuration_successor();

CREATE TABLE mission_agent_v1_operator_releases (
  release_id uuid PRIMARY KEY,
  protocol_version text NOT NULL CHECK(protocol_version='1'),
  artifact_checksum text NOT NULL UNIQUE CHECK(artifact_checksum ~ '^[a-f0-9]{64}$'),
  executable_path text NOT NULL CHECK(
    executable_path='/Users/shawnwollenberg/Library/Application Support/WallyWeb/MissionAgentReplacement/operator-v1.mjs'
  ),
  launch_agent_label text NOT NULL CHECK(
    launch_agent_label='com.wallyweb.mission-agent.replacement-operator'
  ),
  manifest_checksum text NOT NULL UNIQUE CHECK(manifest_checksum ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('approved','retired','revoked')),
  approved_by text NOT NULL,
  approved_at timestamptz NOT NULL
);

CREATE TABLE mission_agent_v1_host_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  host_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  public_key_spki text NOT NULL,
  public_key_fingerprint text NOT NULL UNIQUE
    CHECK(public_key_fingerprint ~ '^ed25519-spki-sha256:[a-f0-9]{64}$'),
  owner_uid bigint NOT NULL CHECK(owner_uid>0),
  status text NOT NULL CHECK(status IN ('pending','active','revoked')),
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  PRIMARY KEY(workspace_id,host_id),
  UNIQUE(workspace_id,agent_id,host_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE RESTRICT,
  CHECK((status='revoked')=(revoked_at IS NOT NULL))
);

CREATE TABLE mission_agent_v1_host_challenges (
  workspace_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  host_id uuid NOT NULL,
  challenge_nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  request_message_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,challenge_id),
  UNIQUE(workspace_id,challenge_nonce),
  UNIQUE(workspace_id,request_message_id),
  FOREIGN KEY(workspace_id,host_id)
    REFERENCES mission_agent_v1_host_identities(workspace_id,host_id) ON DELETE RESTRICT,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '5 minutes')
);

CREATE TABLE mission_agent_v1_host_measurements (
  workspace_id uuid NOT NULL,
  measurement_id uuid NOT NULL,
  challenge_id uuid NOT NULL,
  host_id uuid NOT NULL,
  operator_release_id uuid NOT NULL REFERENCES mission_agent_v1_operator_releases(release_id) ON DELETE RESTRICT,
  startup_evidence_checksum text NOT NULL UNIQUE CHECK(startup_evidence_checksum ~ '^[a-f0-9]{64}$'),
  startup_evidence jsonb NOT NULL,
  signature text NOT NULL,
  journal_generation bigint NOT NULL CHECK(journal_generation>0),
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,measurement_id),
  UNIQUE(workspace_id,challenge_id),
  FOREIGN KEY(workspace_id,challenge_id)
    REFERENCES mission_agent_v1_host_challenges(workspace_id,challenge_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,host_id)
    REFERENCES mission_agent_v1_host_identities(workspace_id,host_id) ON DELETE RESTRICT,
  CHECK(expires_at>observed_at AND expires_at<=observed_at+interval '15 minutes')
);

CREATE TABLE mission_agent_v1_operator_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL,
  host_id uuid NOT NULL,
  operator_release_id uuid NOT NULL REFERENCES mission_agent_v1_operator_releases(release_id) ON DELETE RESTRICT,
  host_measurement_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  deployment_id uuid NOT NULL REFERENCES mission_control_production_deployments(deployment_id) ON DELETE RESTRICT,
  implementation text NOT NULL CHECK(implementation = 'mission-agent-replacement-operator-v1'),
  version text NOT NULL,
  executable_checksum text NOT NULL CHECK(executable_checksum ~ '^[a-f0-9]{64}$'),
  executable_path text NOT NULL,
  owner_uid bigint NOT NULL CHECK(owner_uid > 0),
  journal_schema_version text NOT NULL CHECK(journal_schema_version = 'mission-agent-v1-operator-journal-v1'),
  launch_agent_label text NOT NULL CHECK(launch_agent_label = 'com.wallyweb.mission-agent.replacement-operator'),
  credential_id uuid NOT NULL,
  verified_at timestamptz NOT NULL,
  verification_checksum text NOT NULL CHECK(verification_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,operator_id),
  UNIQUE(workspace_id,agent_id,operator_id,deployment_id),
  FOREIGN KEY(workspace_id,host_id)
    REFERENCES mission_agent_v1_host_identities(workspace_id,host_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,host_measurement_id)
    REFERENCES mission_agent_v1_host_measurements(workspace_id,measurement_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,credential_id) REFERENCES agent_credentials(workspace_id,credential_id) ON DELETE RESTRICT,
  CHECK(executable_path LIKE '/Users/%/Library/Application Support/WallyWeb/MissionAgentReplacement/%')
);

CREATE TABLE mission_agent_v1_rollout_operations (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  host_id uuid NOT NULL,
  deployment_id uuid NOT NULL,
  current_controller_deployment_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  target_artifact_checksum text NOT NULL
    CHECK(target_artifact_checksum = '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09'),
  prior_inventory_checksum text NOT NULL CHECK(prior_inventory_checksum ~ '^[a-f0-9]{64}$'),
  rollback_obligation_id uuid NOT NULL,
  claim_generation integer NOT NULL CHECK(claim_generation = 1),
  fencing_namespace uuid NOT NULL,
  initial_fencing_epoch bigint NOT NULL CHECK(initial_fencing_epoch = 1),
  lifecycle_sequence bigint NOT NULL DEFAULT 0 CHECK(lifecycle_sequence>=0),
  operator_journal_checksum text NOT NULL CHECK(operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN (
    'prepared','preflight_verified','drain_requested','drained_verified','forward_active',
    'grant_issued','grant_delivered','grant_acknowledged','mutation_intent_committed',
    'awaiting_provider_receipt','provider_receipt_accepted','verifying','observing',
    'recovery_only','rollback_grant_issued','rollback_grant_delivered',
    'rollback_grant_acknowledged','rollback_intent_committed','awaiting_rollback_receipt',
    'rollback_receipt_accepted','rollback_verifying','success_verified','rollback_verified',
    'expired_before_mutation','human_intervention_required'
  )),
  drain_evidence_checksum text CHECK(drain_evidence_checksum IS NULL OR drain_evidence_checksum ~ '^[a-f0-9]{64}$'),
  forward_expires_at timestamptz NOT NULL,
  forward_consumed_at timestamptz,
  terminal_evidence_checksum text CHECK(terminal_evidence_checksum IS NULL OR terminal_evidence_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id),
  UNIQUE(workspace_id,authorization_id),
  UNIQUE(workspace_id,authorization_id,execution_id,authorization_fingerprint,prior_inventory_checksum),
  UNIQUE(workspace_id,authorization_id,execution_id,fencing_namespace),
  UNIQUE(workspace_id,authorization_id,execution_id,rollback_obligation_id),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_replacement_execution_claims(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,agent_id,operator_id,deployment_id)
    REFERENCES mission_agent_v1_operator_identities(workspace_id,agent_id,operator_id,deployment_id)
      ON DELETE RESTRICT,
  FOREIGN KEY(current_controller_deployment_id)
    REFERENCES mission_control_production_deployments(deployment_id) ON DELETE RESTRICT,
  FOREIGN KEY(deployment_id,configuration_id)
    REFERENCES mission_control_v1_production_configurations(deployment_id,configuration_id)
      ON DELETE RESTRICT,
  CHECK((state='drained_verified' AND drain_evidence_checksum IS NOT NULL) OR state<>'drained_verified'),
  CHECK(
    (state IN ('success_verified','rollback_verified') AND terminal_evidence_checksum IS NOT NULL) OR
    state NOT IN ('success_verified','rollback_verified')
  )
);

CREATE UNIQUE INDEX mission_agent_v1_one_unresolved_rollout_idx
  ON mission_agent_v1_rollout_operations(workspace_id,agent_id)
  WHERE state NOT IN ('success_verified','rollback_verified','expired_before_mutation');

CREATE TABLE mission_agent_v1_grants (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  grant_kind text NOT NULL CHECK(grant_kind IN ('forward','rollback','recovery')),
  state text NOT NULL CHECK(state IN (
    'proposed','issued','delivered','acknowledged','consumed','expired_before_consumption',
    'revoked_before_consumption','superseded','failed_delivery'
  )),
  operation_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
  operation text NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  operator_id uuid NOT NULL,
  host_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  operator_artifact_checksum text NOT NULL CHECK(operator_artifact_checksum ~ '^[a-f0-9]{64}$'),
  target_artifact_checksum text NOT NULL CHECK(target_artifact_checksum ~ '^[a-f0-9]{64}$'),
  originating_forward_deployment_id uuid NOT NULL,
  current_controller_deployment_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  fencing_generation bigint NOT NULL CHECK(fencing_generation>0),
  rollback_obligation_id uuid NOT NULL,
  grant_checksum text NOT NULL UNIQUE CHECK(grant_checksum ~ '^[a-f0-9]{64}$'),
  grant_bytes text NOT NULL,
  delivery_message_id uuid,
  acknowledgement_message_id uuid,
  acknowledgement_checksum text CHECK(
    acknowledgement_checksum IS NULL OR acknowledgement_checksum ~ '^[a-f0-9]{64}$'
  ),
  host_acknowledgement_signature text,
  issued_at timestamptz,
  delivered_at timestamptz,
  acknowledged_at timestamptz,
  consumed_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id,execution_id,grant_id),
  UNIQUE(workspace_id,authorization_id,execution_id,operation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT,
  CHECK(grant_checksum=encode(digest(convert_to(grant_bytes,'UTF8'),'sha256'),'hex')),
  CHECK(issued_at IS NULL OR expires_at>issued_at)
);

CREATE TABLE mission_agent_v1_lifecycle_events (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  event_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK(sequence>0),
  handler text NOT NULL CHECK(handler IN ('claim','intent','receipt','decision','status','failure')),
  action text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  fencing_generation bigint NOT NULL CHECK(fencing_generation>0),
  request_message_id uuid NOT NULL,
  request_nonce text NOT NULL,
  event_checksum text NOT NULL UNIQUE CHECK(event_checksum ~ '^[a-f0-9]{64}$'),
  audit_reference text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,event_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  UNIQUE(workspace_id,request_message_id),
  UNIQUE(workspace_id,request_nonce),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT
);

CREATE TABLE mission_agent_v1_transition_rules (
  handler text NOT NULL,
  action text NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  PRIMARY KEY(handler,action,from_state)
);

INSERT INTO mission_agent_v1_transition_rules(handler,action,from_state,to_state) VALUES
  ('claim','preflight','prepared','preflight_verified'),
  ('claim','request_drain','preflight_verified','drain_requested'),
  ('claim','verify_drain','drain_requested','drained_verified'),
  ('claim','acquire_lease','drained_verified','forward_active'),
  ('claim','renew_lease','forward_active','forward_active'),
  ('intent','propose_grant','forward_active','grant_issued'),
  ('status','record_grant_delivery','grant_issued','grant_delivered'),
  ('status','acknowledge_grant','grant_delivered','grant_acknowledged'),
  ('decision','expire_grant','grant_issued','forward_active'),
  ('decision','expire_grant','grant_delivered','forward_active'),
  ('decision','expire_grant','grant_acknowledged','forward_active'),
  ('decision','revoke_grant','grant_issued','forward_active'),
  ('decision','revoke_grant','grant_delivered','forward_active'),
  ('decision','revoke_grant','grant_acknowledged','forward_active'),
  ('intent','commit_mutation_intent','grant_acknowledged','mutation_intent_committed'),
  ('status','operator_journal_head','mutation_intent_committed','awaiting_provider_receipt'),
  ('status','anchor_durable_receipt','awaiting_provider_receipt','awaiting_provider_receipt'),
  ('receipt','accept_provider_receipt','awaiting_provider_receipt','provider_receipt_accepted'),
  ('decision','verify_provider_receipt','provider_receipt_accepted','verifying'),
  ('decision','continue_forward','verifying','forward_active'),
  ('decision','observe_stability','verifying','observing'),
  ('decision','evaluate_stability','observing','observing'),
  ('status','runtime_status','observing','observing'),
  ('status','runtime_status','rollback_verifying','rollback_verifying'),
  ('status','rollback_observation','rollback_verifying','rollback_verifying'),
  ('decision','close_success','observing','success_verified'),
  ('failure','activate_rollback','mutation_intent_committed','recovery_only'),
  ('failure','activate_rollback','forward_active','recovery_only'),
  ('failure','activate_rollback','provider_receipt_accepted','recovery_only'),
  ('failure','activate_rollback','verifying','recovery_only'),
  ('failure','activate_rollback','observing','recovery_only'),
  ('intent','propose_grant','recovery_only','rollback_grant_issued'),
  ('status','record_grant_delivery','rollback_grant_issued','rollback_grant_delivered'),
  ('status','acknowledge_grant','rollback_grant_delivered','rollback_grant_acknowledged'),
  ('decision','expire_grant','rollback_grant_issued','recovery_only'),
  ('decision','expire_grant','rollback_grant_delivered','recovery_only'),
  ('decision','expire_grant','rollback_grant_acknowledged','recovery_only'),
  ('decision','revoke_grant','rollback_grant_issued','recovery_only'),
  ('decision','revoke_grant','rollback_grant_delivered','recovery_only'),
  ('decision','revoke_grant','rollback_grant_acknowledged','recovery_only'),
  ('intent','commit_mutation_intent','rollback_grant_acknowledged','rollback_intent_committed'),
  ('status','operator_journal_head','rollback_intent_committed','awaiting_rollback_receipt'),
  ('status','anchor_durable_receipt','awaiting_rollback_receipt','awaiting_rollback_receipt'),
  ('receipt','accept_provider_receipt','awaiting_rollback_receipt','rollback_receipt_accepted'),
  ('decision','verify_provider_receipt','rollback_receipt_accepted','rollback_verifying'),
  ('decision','continue_rollback','rollback_verifying','recovery_only'),
  ('decision','close_rollback','rollback_verifying','rollback_verified'),
  ('failure','require_human_intervention','recovery_only','human_intervention_required'),
  ('failure','require_human_intervention','awaiting_provider_receipt','human_intervention_required'),
  ('failure','require_human_intervention','rollback_intent_committed','human_intervention_required'),
  ('failure','require_human_intervention','awaiting_rollback_receipt','human_intervention_required');

CREATE OR REPLACE FUNCTION advance_mission_agent_v1_lifecycle(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_handler text,
  p_action text,
  p_expected_state text,
  p_expected_sequence bigint,
  p_fencing_generation bigint,
  p_binding jsonb,
  p_event_id uuid,
  p_request_message_id uuid,
  p_request_nonce text,
  p_audit_reference text
) RETURNS TABLE(state text,sequence bigint,event_checksum text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  rollout record;
  next_state text;
  checksum text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text||':'||p_authorization_id::text||':'||p_execution_id::text,0
  ));
  SELECT r.*,o.host_id,o.executable_checksum,c.version configuration_version,
         coalesce((SELECT max(f.epoch) FROM mission_agent_v1_fencing_epochs f
           WHERE f.workspace_id=r.workspace_id AND f.authorization_id=r.authorization_id
             AND f.execution_id=r.execution_id AND f.fencing_namespace=r.fencing_namespace),0) current_fence
    INTO rollout
    FROM mission_agent_v1_rollout_operations r
    JOIN mission_agent_v1_operator_identities o
      ON o.workspace_id=r.workspace_id AND o.operator_id=r.operator_id
    JOIN mission_control_v1_production_configurations c
      ON c.configuration_id=r.configuration_id
   WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
     AND r.execution_id=p_execution_id
   FOR UPDATE OF r;
  SELECT rule.to_state INTO next_state
    FROM mission_agent_v1_transition_rules rule
   WHERE rule.handler=p_handler AND rule.action=p_action AND rule.from_state=p_expected_state;
  IF rollout IS NULL OR next_state IS NULL OR rollout.state<>p_expected_state
     OR rollout.lifecycle_sequence<>p_expected_sequence
     OR rollout.current_fence<>p_fencing_generation
     OR rollout.authorization_fingerprint<>p_binding->>'authorizationFingerprint'
     OR rollout.operator_id::text<>p_binding->>'operatorId'
     OR rollout.host_id::text<>p_binding->>'hostId'
     OR rollout.executable_checksum<>p_binding->>'operatorArtifactSha256'
     OR rollout.agent_id::text<>p_binding->>'agentId'
     OR rollout.target_artifact_checksum<>p_binding->>'targetArtifactSha256'
     OR rollout.deployment_id::text<>p_binding->>'originatingForwardDeploymentId'
     OR rollout.current_controller_deployment_id::text<>p_binding->>'currentControllerDeploymentId'
     OR rollout.configuration_version<>(p_binding->>'configurationVersion')::bigint
  THEN
    RAISE EXCEPTION 'v1 lifecycle identity, fence, sequence, or state is contradictory';
  END IF;
  checksum := encode(digest(convert_to(jsonb_build_object(
    'action',p_action,'authorizationId',p_authorization_id,'eventId',p_event_id,
    'executionId',p_execution_id,'fencingGeneration',p_fencing_generation,
    'fromState',p_expected_state,'handler',p_handler,'requestMessageId',p_request_message_id,
    'requestNonce',p_request_nonce,'sequence',p_expected_sequence+1,'toState',next_state,
    'workspaceId',p_workspace_id
  )::text,'UTF8'),'sha256'),'hex');
  INSERT INTO mission_agent_v1_lifecycle_events(
    workspace_id,authorization_id,execution_id,event_id,sequence,handler,action,from_state,to_state,
    fencing_generation,request_message_id,request_nonce,event_checksum,audit_reference
  ) VALUES(
    p_workspace_id,p_authorization_id,p_execution_id,p_event_id,p_expected_sequence+1,p_handler,p_action,
    p_expected_state,next_state,p_fencing_generation,p_request_message_id,p_request_nonce,checksum,p_audit_reference
  );
  UPDATE mission_agent_v1_rollout_operations
     SET state=next_state,lifecycle_sequence=p_expected_sequence+1,updated_at=clock_timestamp()
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id AND execution_id=p_execution_id;
  RETURN QUERY SELECT next_state,p_expected_sequence+1,checksum;
END $$;

REVOKE ALL ON FUNCTION advance_mission_agent_v1_lifecycle(
  uuid,uuid,uuid,text,text,text,bigint,bigint,jsonb,uuid,uuid,text,text
) FROM PUBLIC,mission_control_v1_runtime,mission_control_v1_controller,mission_control_v1_verifier;

CREATE TABLE mission_agent_v1_fencing_epochs (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  fencing_namespace uuid NOT NULL,
  epoch bigint NOT NULL CHECK(epoch > 0),
  predecessor_epoch bigint,
  controller_identity text NOT NULL,
  request_message_id uuid NOT NULL,
  request_nonce text NOT NULL,
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,fencing_namespace,epoch),
  UNIQUE(fencing_namespace,epoch),
  UNIQUE(fencing_namespace,request_message_id),
  UNIQUE(fencing_namespace,request_nonce),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,fencing_namespace)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id,fencing_namespace)
      ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,fencing_namespace,predecessor_epoch)
    REFERENCES mission_agent_v1_fencing_epochs(workspace_id,authorization_id,execution_id,fencing_namespace,epoch)
      DEFERRABLE INITIALLY IMMEDIATE,
  CHECK((epoch=1 AND predecessor_epoch IS NULL) OR (epoch>1 AND predecessor_epoch=epoch-1))
);

CREATE OR REPLACE FUNCTION validate_v1_fencing_successor()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.fencing_namespace::text,0));
  SELECT max(epoch) INTO current_epoch
    FROM mission_agent_v1_fencing_epochs
   WHERE workspace_id=NEW.workspace_id
     AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id
     AND fencing_namespace=NEW.fencing_namespace;
  IF current_epoch IS NULL THEN
    IF NEW.epoch <> 1 OR NEW.predecessor_epoch IS NOT NULL THEN
      RAISE EXCEPTION 'initial v1 fencing epoch must be one';
    END IF;
  ELSIF NEW.epoch <> current_epoch + 1 OR NEW.predecessor_epoch <> current_epoch THEN
    RAISE EXCEPTION 'v1 fencing epoch is not the exact successor';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_fencing_successor_guard
BEFORE INSERT ON mission_agent_v1_fencing_epochs
FOR EACH ROW EXECUTE FUNCTION validate_v1_fencing_successor();

CREATE OR REPLACE FUNCTION advance_mission_agent_v1_fencing_epoch(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_fencing_namespace uuid,
  p_expected_epoch bigint,
  p_controller_identity text,
  p_request_message_id uuid,
  p_request_nonce text,
  p_evidence_checksum text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE current_epoch bigint;
DECLARE next_epoch bigint;
BEGIN
  IF p_evidence_checksum !~ '^[a-f0-9]{64}$' OR NOT EXISTS (
    SELECT 1
      FROM mission_agent_v1_rollout_operations r
      JOIN mission_control_production_deployments d
        ON d.deployment_id=r.current_controller_deployment_id
     WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
       AND r.execution_id=p_execution_id AND r.fencing_namespace=p_fencing_namespace
       AND d.task_arn=p_controller_identity AND d.attestation_expires_at>clock_timestamp()
       AND d.attestation_checksum=p_evidence_checksum
  ) THEN
    RAISE EXCEPTION 'v1 fencing controller evidence is invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_fencing_namespace::text,0));
  SELECT coalesce(max(epoch),0) INTO current_epoch
    FROM mission_agent_v1_fencing_epochs
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
     AND execution_id=p_execution_id AND fencing_namespace=p_fencing_namespace;
  IF current_epoch<>p_expected_epoch THEN
    RAISE EXCEPTION 'v1 fencing compare-and-set failed';
  END IF;
  next_epoch := current_epoch + 1;
  INSERT INTO mission_agent_v1_fencing_epochs(
    workspace_id,authorization_id,execution_id,fencing_namespace,epoch,
    predecessor_epoch,controller_identity,request_message_id,request_nonce,evidence_checksum
  ) VALUES(
    p_workspace_id,p_authorization_id,p_execution_id,p_fencing_namespace,next_epoch,
    CASE WHEN next_epoch=1 THEN NULL ELSE next_epoch-1 END,p_controller_identity,
    p_request_message_id,p_request_nonce,p_evidence_checksum
  );
  RETURN next_epoch;
END $$;

REVOKE INSERT,UPDATE,DELETE ON mission_agent_v1_fencing_epochs FROM PUBLIC;
REVOKE ALL ON FUNCTION advance_mission_agent_v1_fencing_epoch(uuid,uuid,uuid,uuid,bigint,text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_mission_agent_v1_fencing_epoch(uuid,uuid,uuid,uuid,bigint,text,uuid,text,text)
  TO mission_control_v1_controller;

CREATE TABLE mission_agent_v1_rollback_obligations (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  prior_inventory_checksum text NOT NULL CHECK(prior_inventory_checksum ~ '^[a-f0-9]{64}$'),
  inverse_protocol text NOT NULL CHECK(inverse_protocol = 'mission-agent-v1-rollback-sequence-v1'),
  inverse_operations jsonb NOT NULL CHECK(inverse_operations = '[
    "remove_staged_artifact",
    "stop_agent",
    "restore_previous_version",
    "restore_previous_launch_configuration",
    "install_launch_configuration",
    "start_agent",
    "verify_process",
    "collect_heartbeats",
    "verify_capabilities",
    "verify_rollback"
  ]'::jsonb),
  opened_by_operation_id uuid NOT NULL,
  opened_by_intent_checksum text NOT NULL CHECK(opened_by_intent_checksum ~ '^[a-f0-9]{64}$'),
  required_inverse_operations jsonb,
  rollback_plan_checksum text CHECK(
    rollback_plan_checksum IS NULL OR rollback_plan_checksum ~ '^[a-f0-9]{64}$'
  ),
  state text NOT NULL CHECK(state IN ('open','executing','human_intervention_required','verified_closed')),
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  closure_outcome text CHECK(closure_outcome IS NULL OR closure_outcome IN ('success_verified','rollback_verified')),
  closure_evidence_checksum text CHECK(closure_evidence_checksum IS NULL OR closure_evidence_checksum ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,obligation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,opened_by_operation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,obligation_id,authorization_fingerprint,prior_inventory_checksum),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,authorization_fingerprint,prior_inventory_checksum)
    REFERENCES mission_agent_v1_rollout_operations(
      workspace_id,authorization_id,execution_id,authorization_fingerprint,prior_inventory_checksum
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,opened_by_operation_id)
    REFERENCES mission_agent_replacement_mutation_intents(
      workspace_id,authorization_id,execution_id,operation_id
    ) DEFERRABLE INITIALLY DEFERRED,
  CHECK(
    (state='verified_closed' AND closed_at IS NOT NULL AND closure_outcome IS NOT NULL AND closure_evidence_checksum IS NOT NULL) OR
    (state<>'verified_closed' AND closed_at IS NULL AND closure_outcome IS NULL AND closure_evidence_checksum IS NULL)
  ),
  CHECK(
    (state IN ('executing','human_intervention_required') AND required_inverse_operations IS NOT NULL
      AND rollback_plan_checksum IS NOT NULL) OR
    (state='open' AND required_inverse_operations IS NULL AND rollback_plan_checksum IS NULL) OR
    state='verified_closed'
  )
);

CREATE UNIQUE INDEX mission_agent_v1_one_open_rollback_idx
  ON mission_agent_v1_rollback_obligations(workspace_id,authorization_id,execution_id)
  WHERE state <> 'verified_closed';

CREATE TABLE mission_agent_v1_operator_confirmations (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
  operation text NOT NULL CHECK(operation IN (
    'observe','stage_artifact','verify_artifact','stop_agent','install_agent',
    'install_launch_configuration','start_agent','verify_process','collect_heartbeats',
    'verify_capabilities','remove_staged_artifact','restore_previous_launch_configuration',
    'restore_previous_version','verify_rollback'
  )),
  sequence integer NOT NULL CHECK(sequence > 0),
  fencing_generation bigint NOT NULL CHECK(fencing_generation > 0),
  request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
  request_message_id uuid NOT NULL,
  request_nonce text NOT NULL,
  authenticated_message_id uuid NOT NULL,
  authenticated_nonce text NOT NULL,
  prior_operator_journal_checksum text NOT NULL CHECK(prior_operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  operator_journal_checksum text NOT NULL CHECK(operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  UNIQUE(workspace_id,request_message_id),
  UNIQUE(workspace_id,request_nonce),
  UNIQUE(workspace_id,authenticated_message_id),
  UNIQUE(workspace_id,authenticated_nonce),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT
);

CREATE TABLE mission_agent_v1_durable_receipt_anchors (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
  fencing_generation bigint NOT NULL CHECK(fencing_generation>0),
  receipt_checksum text NOT NULL CHECK(receipt_checksum ~ '^[a-f0-9]{64}$'),
  host_signature text NOT NULL,
  request_message_id uuid NOT NULL,
  request_nonce text NOT NULL,
  anchored_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(workspace_id,request_message_id),
  UNIQUE(workspace_id,request_nonce),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,grant_id)
    REFERENCES mission_agent_v1_grants(workspace_id,authorization_id,execution_id,grant_id)
      ON DELETE RESTRICT
);

CREATE TABLE mission_agent_v1_provider_mutations (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  obligation_id uuid NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  prior_inventory_checksum text NOT NULL CHECK(prior_inventory_checksum ~ '^[a-f0-9]{64}$'),
  phase text NOT NULL CHECK(phase IN ('forward','rollback')),
  phase_sequence integer NOT NULL CHECK(phase_sequence > 0),
  operation text NOT NULL CHECK(operation IN (
    'stage_artifact','install_agent','install_launch_configuration','stop_agent','start_agent',
    'restore_previous_version','remove_staged_artifact','restore_previous_launch_configuration'
  )),
  sequence integer NOT NULL CHECK(sequence > 0),
  fencing_namespace uuid NOT NULL,
  fencing_epoch bigint NOT NULL CHECK(fencing_epoch > 0),
  intent_checksum text NOT NULL CHECK(intent_checksum ~ '^[a-f0-9]{64}$'),
  request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
  request_message_id uuid NOT NULL,
  request_nonce text NOT NULL,
  prior_operator_journal_checksum text NOT NULL CHECK(prior_operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  operator_journal_checksum text NOT NULL CHECK(operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  prior_state_checksum text NOT NULL CHECK(prior_state_checksum ~ '^[a-f0-9]{64}$'),
  resulting_state_checksum text NOT NULL CHECK(resulting_state_checksum ~ '^[a-f0-9]{64}$'),
  receipt_checksum text NOT NULL CHECK(receipt_checksum ~ '^[a-f0-9]{64}$'),
  local_journal_entry_id uuid NOT NULL,
  completed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  UNIQUE(workspace_id,authorization_id,execution_id,phase,phase_sequence),
  UNIQUE(workspace_id,request_message_id),
  UNIQUE(workspace_id,request_nonce),
  UNIQUE(provider_mutation_id),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,grant_id)
    REFERENCES mission_agent_v1_grants(
      workspace_id,authorization_id,execution_id,grant_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,operation_id)
    REFERENCES mission_agent_replacement_mutation_intents(
      workspace_id,authorization_id,execution_id,operation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,obligation_id,authorization_fingerprint,prior_inventory_checksum)
    REFERENCES mission_agent_v1_rollback_obligations(
      workspace_id,authorization_id,execution_id,obligation_id,authorization_fingerprint,prior_inventory_checksum
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,fencing_namespace,fencing_epoch)
    REFERENCES mission_agent_v1_fencing_epochs(
      workspace_id,authorization_id,execution_id,fencing_namespace,epoch
    ) ON DELETE RESTRICT
);

CREATE TABLE mission_agent_v1_provider_receipts (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  operation text NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  fencing_generation bigint NOT NULL CHECK(fencing_generation>0),
  sequence bigint NOT NULL CHECK(sequence>0),
  operator_id uuid NOT NULL,
  host_id uuid NOT NULL,
  operator_artifact_checksum text NOT NULL CHECK(operator_artifact_checksum ~ '^[a-f0-9]{64}$'),
  agent_id uuid NOT NULL,
  target_artifact_checksum text NOT NULL CHECK(target_artifact_checksum ~ '^[a-f0-9]{64}$'),
  prior_state_checksum text NOT NULL CHECK(prior_state_checksum ~ '^[a-f0-9]{64}$'),
  resulting_state_checksum text NOT NULL CHECK(resulting_state_checksum ~ '^[a-f0-9]{64}$'),
  local_journal_entry_id uuid NOT NULL,
  executed_at timestamptz NOT NULL,
  request_message_id uuid NOT NULL,
  receipt_message_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('succeeded','failed')),
  error_classification text,
  receipt_checksum text NOT NULL CHECK(receipt_checksum ~ '^[a-f0-9]{64}$'),
  receipt_bytes text NOT NULL,
  authenticated_receipt_tag text NOT NULL CHECK(authenticated_receipt_tag ~ '^[a-f0-9]{64}$'),
  host_receipt_signature text NOT NULL,
  verification_evidence_checksum text NOT NULL CHECK(verification_evidence_checksum ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(receipt_checksum),
  UNIQUE(workspace_id,receipt_message_id),
  UNIQUE(workspace_id,authorization_id,execution_id,local_journal_entry_id),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,provider_mutation_id)
    REFERENCES mission_agent_v1_provider_mutations(
      workspace_id,authorization_id,execution_id,provider_mutation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,grant_id)
    REFERENCES mission_agent_v1_grants(
      workspace_id,authorization_id,execution_id,grant_id
    ) ON DELETE RESTRICT,
  CHECK(receipt_checksum=encode(digest(convert_to(receipt_bytes,'UTF8'),'sha256'),'hex'))
);

CREATE TABLE mission_agent_v1_closure_evidence (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('success_verified','rollback_verified')),
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  process_checksum text NOT NULL CHECK(process_checksum ~ '^[a-f0-9]{64}$'),
  heartbeat_checksum text NOT NULL CHECK(heartbeat_checksum ~ '^[a-f0-9]{64}$'),
  capability_checksum text NOT NULL CHECK(capability_checksum ~ '^[a-f0-9]{64}$'),
  projection_checksum text NOT NULL CHECK(projection_checksum ~ '^[a-f0-9]{64}$'),
  inventory_checksum text NOT NULL CHECK(inventory_checksum ~ '^[a-f0-9]{64}$'),
  evidence_bytes text NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id,execution_id,outcome,evidence_checksum),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT,
  CHECK(evidence_checksum=encode(digest(convert_to(evidence_bytes,'UTF8'),'sha256'),'hex')),
  CHECK(capability_checksum=heartbeat_checksum)
);

CREATE TABLE mission_agent_v1_verified_evidence (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK(evidence_type IN (
    'process','heartbeat-capability','projection','smoke','rollback-equivalence'
  )),
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  producer_operation_id uuid,
  authenticated_receipt_tag text CHECK(authenticated_receipt_tag IS NULL OR authenticated_receipt_tag ~ '^[a-f0-9]{64}$'),
  canonical_source_checksum text,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_v1_rollout_operations(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,producer_operation_id)
    REFERENCES mission_agent_replacement_receipts(
      workspace_id,authorization_id,execution_id,operation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,evidence_type,canonical_source_checksum)
    REFERENCES mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum
    ) ON DELETE RESTRICT,
  CHECK(
    (producer_operation_id IS NOT NULL AND authenticated_receipt_tag IS NOT NULL
      AND canonical_source_checksum IS NULL) OR
    (producer_operation_id IS NULL AND authenticated_receipt_tag IS NULL
      AND canonical_source_checksum IS NOT NULL)
  ),
  CHECK(expires_at > observed_at)
);

CREATE OR REPLACE FUNCTION record_mission_agent_v1_verified_evidence(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_evidence_type text,
  p_evidence jsonb,
  p_producer_operation_id uuid,
  p_authenticated_receipt_tag text,
  p_observed_at timestamptz,
  p_expires_at timestamptz
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  computed_checksum text;
  expected_operation text;
BEGIN
  IF p_evidence_type NOT IN (
    'process','heartbeat-capability','projection','smoke','rollback-equivalence'
  ) OR p_evidence IS NULL OR p_observed_at > clock_timestamp() + interval '1 minute'
     OR p_observed_at < clock_timestamp() - interval '15 minutes'
     OR p_expires_at <= clock_timestamp()
     OR p_expires_at > p_observed_at + interval '15 minutes'
  THEN
    RAISE EXCEPTION 'v1 verifier evidence is unauthenticated or stale';
  END IF;
  computed_checksum := encode(digest(convert_to(p_evidence::text,'UTF8'),'sha256'),'hex');
  expected_operation := CASE p_evidence_type
    WHEN 'process' THEN 'verify_process'
    WHEN 'heartbeat-capability' THEN 'collect_heartbeats'
    WHEN 'projection' THEN 'verify_projection'
    WHEN 'smoke' THEN 'read_only_smoke'
    WHEN 'rollback-equivalence' THEN 'verify_rollback'
  END;
  IF NOT EXISTS (
    SELECT 1 FROM mission_agent_replacement_receipts r
     WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
       AND r.execution_id=p_execution_id AND r.operation_id=p_producer_operation_id
       AND r.authentication_tag=p_authenticated_receipt_tag
       AND r.operation=expected_operation
       AND r.result_checksum=computed_checksum
       AND r.received_at >= clock_timestamp() - interval '15 minutes'
       AND p_observed_at >= r.received_at
       AND p_observed_at <= r.received_at + interval '1 minute'
  ) THEN
    RAISE EXCEPTION 'v1 verifier evidence is not bound to its authenticated producer receipt';
  END IF;
  INSERT INTO mission_agent_v1_verified_evidence(
    workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
    producer_operation_id,authenticated_receipt_tag,observed_at,expires_at
  ) VALUES(
    p_workspace_id,p_authorization_id,p_execution_id,p_evidence_type,computed_checksum,p_evidence,
    p_producer_operation_id,p_authenticated_receipt_tag,p_observed_at,p_expires_at
  );
  RETURN computed_checksum;
END $$;

CREATE OR REPLACE FUNCTION record_mission_agent_v1_canonical_evidence(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_evidence_type text,
  p_source_checksum text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_row record;
BEGIN
  SELECT * INTO source_row FROM mission_agent_replacement_evidence e
   WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
     AND e.execution_id=p_execution_id AND e.evidence_type=p_evidence_type
     AND e.evidence_checksum=p_source_checksum AND e.expires_at>clock_timestamp();
  IF source_row IS NULL THEN
    RAISE EXCEPTION 'v1 canonical evidence source is unavailable or contradictory';
  END IF;
  INSERT INTO mission_agent_v1_verified_evidence(
    workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
    producer_operation_id,authenticated_receipt_tag,canonical_source_checksum,observed_at,expires_at
  ) VALUES(
    p_workspace_id,p_authorization_id,p_execution_id,p_evidence_type,source_row.evidence_checksum,
    source_row.evidence,NULL,NULL,source_row.evidence_checksum,source_row.observed_at,source_row.expires_at
  ) ON CONFLICT DO NOTHING;
  RETURN source_row.evidence_checksum;
END $$;

REVOKE ALL ON FUNCTION record_mission_agent_v1_canonical_evidence(
  uuid,uuid,uuid,text,text
) FROM PUBLIC,mission_control_v1_runtime,mission_control_v1_controller,mission_control_v1_verifier;

REVOKE INSERT,UPDATE,DELETE ON mission_agent_v1_verified_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION record_mission_agent_v1_verified_evidence(
  uuid,uuid,uuid,text,jsonb,uuid,text,timestamptz,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_mission_agent_v1_verified_evidence(
  uuid,uuid,uuid,text,jsonb,uuid,text,timestamptz,timestamptz
) TO mission_control_v1_verifier;

CREATE OR REPLACE FUNCTION validate_v1_closure_evidence_sources()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_type='process'
       AND e.evidence_checksum=NEW.process_checksum AND e.expires_at>NEW.verified_at
  ) OR NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_type='heartbeat-capability'
       AND e.evidence_checksum=NEW.heartbeat_checksum AND e.expires_at>NEW.verified_at
  ) OR NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_type='projection'
       AND e.evidence_checksum=NEW.projection_checksum AND e.expires_at>NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'v1 closure evidence lacks canonical source evidence';
  END IF;
  IF NEW.outcome='success_verified' AND NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_type='smoke'
       AND e.evidence_checksum=NEW.inventory_checksum AND e.expires_at>NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'v1 success closure lacks canonical smoke evidence';
  END IF;
  IF NEW.outcome='rollback_verified' AND NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_type='rollback-equivalence'
       AND e.evidence_checksum=NEW.inventory_checksum AND e.expires_at>NEW.verified_at
  ) THEN
    RAISE EXCEPTION 'v1 rollback closure lacks equivalence evidence';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_closure_source_guard
BEFORE INSERT ON mission_agent_v1_closure_evidence
FOR EACH ROW EXECUTE FUNCTION validate_v1_closure_evidence_sources();

REVOKE INSERT,UPDATE,DELETE ON mission_agent_v1_closure_evidence FROM PUBLIC;

CREATE OR REPLACE FUNCTION validate_v1_rollout_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE claim record;
DECLARE configuration record;
BEGIN
  SELECT agent_id,authorization_fingerprint,generation INTO claim
    FROM mission_agent_replacement_execution_claims
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id;
  SELECT c.deployment_id,c.state,c.configuration_checksum,
         d.configuration_checksum AS attested_configuration_checksum
    INTO configuration
    FROM mission_control_v1_production_configurations c
    JOIN mission_control_production_deployments d ON d.deployment_id=c.deployment_id
   WHERE c.configuration_id=NEW.configuration_id;
  IF claim IS NULL OR claim.agent_id<>NEW.agent_id
     OR claim.authorization_fingerprint<>NEW.authorization_fingerprint
     OR claim.generation<>NEW.claim_generation
     OR configuration IS NULL OR configuration.deployment_id<>NEW.deployment_id
     OR configuration.configuration_checksum<>configuration.attested_configuration_checksum
     OR configuration.state NOT IN ('canary_authorized','forward_active') THEN
    RAISE EXCEPTION 'v1 rollout identity binding is invalid';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_rollout_binding_guard
BEFORE INSERT ON mission_agent_v1_rollout_operations
FOR EACH ROW EXECUTE FUNCTION validate_v1_rollout_binding();

CREATE OR REPLACE FUNCTION validate_v1_current_fencing_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
DECLARE current_epoch_created_at timestamptz;
DECLARE historical_completion_allowed boolean;
DECLARE expected_intent record;
DECLARE rollout record;
DECLARE obligation record;
DECLARE existing_phase_count integer;
DECLARE expected_rollback_operation text;
DECLARE expected_forward_operation text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW.authorization_id::text || ':' || NEW.execution_id::text || ':' || NEW.phase,0
  ));
  SELECT epoch,created_at INTO current_epoch,current_epoch_created_at
    FROM mission_agent_v1_fencing_epochs
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id AND fencing_namespace=NEW.fencing_namespace
   ORDER BY epoch DESC LIMIT 1;
  historical_completion_allowed:=current_epoch>NEW.fencing_epoch
    AND NEW.completed_at<=current_epoch_created_at
    AND EXISTS (
      SELECT 1
        FROM mission_agent_v1_grants g
        JOIN mission_agent_v1_operator_confirmations c
          ON c.workspace_id=g.workspace_id AND c.authorization_id=g.authorization_id
         AND c.execution_id=g.execution_id AND c.provider_mutation_id=g.provider_mutation_id
       WHERE g.workspace_id=NEW.workspace_id AND g.authorization_id=NEW.authorization_id
         AND g.execution_id=NEW.execution_id AND g.grant_id=NEW.grant_id
         AND g.fencing_generation=NEW.fencing_epoch
         AND c.fencing_generation=NEW.fencing_epoch
         AND c.request_message_id=NEW.request_message_id
         AND c.request_nonce=NEW.request_nonce
    )
    AND EXISTS (
      SELECT 1 FROM mission_agent_v1_durable_receipt_anchors a
       WHERE a.workspace_id=NEW.workspace_id AND a.authorization_id=NEW.authorization_id
         AND a.execution_id=NEW.execution_id AND a.grant_id=NEW.grant_id
         AND a.provider_mutation_id=NEW.provider_mutation_id
         AND a.fencing_generation=NEW.fencing_epoch
         AND a.receipt_checksum=NEW.receipt_checksum
         AND a.anchored_at<current_epoch_created_at
    );
  SELECT intent_checksum,operation,sequence,status INTO expected_intent
    FROM mission_agent_replacement_mutation_intents
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id AND operation_id=NEW.operation_id;
  SELECT state,forward_expires_at INTO rollout
    FROM mission_agent_v1_rollout_operations
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id;
  SELECT state,inverse_operations,required_inverse_operations INTO obligation
    FROM mission_agent_v1_rollback_obligations
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id AND obligation_id=NEW.obligation_id;
  IF current_epoch IS NULL OR (current_epoch<>NEW.fencing_epoch AND NOT historical_completion_allowed)
     OR expected_intent IS NULL OR expected_intent.intent_checksum<>NEW.intent_checksum
     OR expected_intent.operation<>NEW.operation OR expected_intent.sequence<>NEW.sequence
     OR expected_intent.status<>'prepared' OR obligation IS NULL
     OR obligation.state='verified_closed' THEN
    RAISE EXCEPTION 'v1 mutation has stale fencing or contradictory intent';
  END IF;
  IF NEW.phase='rollback' THEN
    SELECT count(*)::int INTO existing_phase_count
      FROM mission_agent_v1_provider_mutations
     WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
       AND execution_id=NEW.execution_id AND phase='rollback';
    expected_rollback_operation := obligation.required_inverse_operations->>existing_phase_count;
    IF rollout.state NOT IN ('awaiting_rollback_receipt','recovery_only','human_intervention_required')
       OR obligation.state<>'executing'
       OR NEW.phase_sequence<>existing_phase_count+1
       OR expected_rollback_operation IS NULL
       OR NEW.operation<>expected_rollback_operation
       OR NOT (obligation.inverse_operations ? NEW.operation) THEN
      RAISE EXCEPTION 'v1 rollback mutation is outside inverse authority';
    END IF;
  ELSIF rollout.state<>'awaiting_provider_receipt' OR NEW.phase<>'forward' THEN
    RAISE EXCEPTION 'v1 forward mutation authority is unavailable';
  ELSE
    expected_forward_operation := (
      ARRAY['stage_artifact','stop_agent','install_agent','install_launch_configuration','start_agent']
    )[NEW.phase_sequence];
    IF expected_forward_operation IS NULL OR NEW.operation<>expected_forward_operation THEN
      RAISE EXCEPTION 'v1 forward mutation is outside the canonical prefix';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_provider_mutation_guard
BEFORE INSERT ON mission_agent_v1_provider_mutations
FOR EACH ROW EXECUTE FUNCTION validate_v1_current_fencing_epoch();

CREATE OR REPLACE FUNCTION validate_v1_provider_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_tag text;
BEGIN
  SELECT authentication_tag INTO source_tag
    FROM mission_agent_replacement_receipts
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id AND operation_id=NEW.operation_id;
  IF source_tag IS NULL OR source_tag<>NEW.authenticated_receipt_tag THEN
    RAISE EXCEPTION 'v1 provider receipt lacks authenticated source receipt';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_provider_receipt_guard
BEFORE INSERT ON mission_agent_v1_provider_receipts
FOR EACH ROW EXECUTE FUNCTION validate_v1_provider_receipt();

CREATE OR REPLACE FUNCTION protect_v1_intent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_rollout_operations r
     WHERE r.workspace_id=OLD.workspace_id AND r.authorization_id=OLD.authorization_id
       AND r.execution_id=OLD.execution_id
  ) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'v1 mutation intent cannot be deleted';
  END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.authorization_id<>OLD.authorization_id
     OR NEW.execution_id<>OLD.execution_id OR NEW.operation_id<>OLD.operation_id
     OR NEW.credential_id<>OLD.credential_id OR NEW.claim_generation<>OLD.claim_generation
     OR NEW.sequence<>OLD.sequence OR NEW.operation<>OLD.operation
     OR NEW.fixed_arguments_checksum<>OLD.fixed_arguments_checksum
     OR NEW.expected_precondition_checksum<>OLD.expected_precondition_checksum
     OR NEW.expected_postcondition_checksum<>OLD.expected_postcondition_checksum
     OR NEW.from_state<>OLD.from_state OR NEW.to_state<>OLD.to_state
     OR NEW.retry_policy<>OLD.retry_policy OR NEW.rollback_obligation<>OLD.rollback_obligation
     OR NEW.intent_checksum<>OLD.intent_checksum OR NEW.created_at<>OLD.created_at THEN
    RAISE EXCEPTION 'v1 mutation intent identity is immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_intent_immutable_guard
BEFORE UPDATE OR DELETE ON mission_agent_replacement_mutation_intents
FOR EACH ROW EXECUTE FUNCTION protect_v1_intent();

CREATE OR REPLACE FUNCTION protect_v1_source_evidence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM mission_agent_v1_rollout_operations r
     WHERE r.workspace_id=OLD.workspace_id AND r.authorization_id=OLD.authorization_id
       AND r.execution_id=OLD.execution_id
  ) THEN
    RAISE EXCEPTION 'v1 canonical source evidence is append-only';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE TRIGGER mission_agent_v1_source_evidence_guard
BEFORE UPDATE OR DELETE ON mission_agent_replacement_evidence
FOR EACH ROW EXECUTE FUNCTION protect_v1_source_evidence();

CREATE OR REPLACE FUNCTION prevent_v1_canonical_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'v1 canonical record is append-only';
END $$;

CREATE TRIGGER mission_agent_v1_deployment_append_only
BEFORE UPDATE OR DELETE ON mission_control_production_deployments
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_configuration_append_only
BEFORE UPDATE OR DELETE ON mission_control_v1_production_configurations
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_operator_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_operator_identities
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_epoch_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_fencing_epochs
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_provider_mutation_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_provider_mutations
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_durable_receipt_anchor_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_durable_receipt_anchors
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_provider_receipt_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_provider_receipts
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();
CREATE TRIGGER mission_agent_v1_closure_evidence_append_only
BEFORE UPDATE OR DELETE ON mission_agent_v1_closure_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_v1_canonical_mutation();

CREATE OR REPLACE FUNCTION validate_v1_rollout_state_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.authorization_id<>OLD.authorization_id
     OR NEW.execution_id<>OLD.execution_id OR NEW.agent_id<>OLD.agent_id
     OR NEW.operator_id<>OLD.operator_id OR NEW.deployment_id<>OLD.deployment_id
     OR NEW.configuration_id<>OLD.configuration_id
     OR NEW.authorization_fingerprint<>OLD.authorization_fingerprint
     OR NEW.target_artifact_checksum<>OLD.target_artifact_checksum
     OR NEW.prior_inventory_checksum<>OLD.prior_inventory_checksum
     OR NEW.claim_generation<>OLD.claim_generation
     OR NEW.fencing_namespace<>OLD.fencing_namespace
     OR NEW.initial_fencing_epoch<>OLD.initial_fencing_epoch THEN
    RAISE EXCEPTION 'v1 rollout identity is immutable';
  END IF;
  IF NEW.state IN ('success_verified','rollback_verified') AND NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_closure_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.outcome=NEW.state
       AND e.evidence_checksum=NEW.terminal_evidence_checksum
  ) THEN
    RAISE EXCEPTION 'v1 terminal state requires canonical closure evidence';
  END IF;
  IF NEW.state IN ('success_verified','rollback_verified') AND EXISTS (
    SELECT 1 FROM mission_agent_v1_rollback_obligations o
     WHERE o.workspace_id=NEW.workspace_id AND o.authorization_id=NEW.authorization_id
       AND o.execution_id=NEW.execution_id AND o.state<>'verified_closed'
  ) THEN
    RAISE EXCEPTION 'v1 terminal state requires rollback obligation discharge';
  END IF;
  IF (NEW.state<>OLD.state OR NEW.lifecycle_sequence<>OLD.lifecycle_sequence)
     AND NEW.state NOT IN ('success_verified','rollback_verified')
     AND NOT EXISTS (
       SELECT 1 FROM mission_agent_v1_lifecycle_events e
        WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
          AND e.execution_id=NEW.execution_id AND e.sequence=NEW.lifecycle_sequence
          AND e.from_state=OLD.state AND e.to_state=NEW.state
          AND NEW.lifecycle_sequence=OLD.lifecycle_sequence+1
     ) THEN
    RAISE EXCEPTION 'v1 rollout state may advance only through its authoritative lifecycle event';
  END IF;
  IF NEW.state='expired_before_mutation' AND (
    EXISTS (
      SELECT 1 FROM mission_agent_replacement_mutation_intents i
       WHERE i.workspace_id=NEW.workspace_id AND i.authorization_id=NEW.authorization_id
         AND i.execution_id=NEW.execution_id AND i.rollback_obligation
    ) OR EXISTS (
      SELECT 1 FROM mission_agent_v1_rollback_obligations o
       WHERE o.workspace_id=NEW.workspace_id AND o.authorization_id=NEW.authorization_id
         AND o.execution_id=NEW.execution_id
    )
  ) THEN
    RAISE EXCEPTION 'mutated rollout cannot expire before mutation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_rollout_state_guard
BEFORE UPDATE ON mission_agent_v1_rollout_operations
FOR EACH ROW EXECUTE FUNCTION validate_v1_rollout_state_change();

CREATE OR REPLACE FUNCTION mission_agent_v1_rollback_plan(forward_prefix jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE forward_prefix
    WHEN '["stage_artifact"]'::jsonb THEN
      '["remove_staged_artifact"]'::jsonb
    WHEN '["stage_artifact","stop_agent"]'::jsonb THEN
      '["start_agent","remove_staged_artifact"]'::jsonb
    WHEN '["stage_artifact","stop_agent","install_agent"]'::jsonb THEN
      '["restore_previous_version","start_agent","remove_staged_artifact"]'::jsonb
    WHEN '["stage_artifact","stop_agent","install_agent","install_launch_configuration"]'::jsonb THEN
      '["restore_previous_launch_configuration","restore_previous_version","start_agent","remove_staged_artifact"]'::jsonb
    WHEN '["stage_artifact","stop_agent","install_agent","install_launch_configuration","start_agent"]'::jsonb THEN
      '["stop_agent","restore_previous_launch_configuration","restore_previous_version","start_agent","remove_staged_artifact"]'::jsonb
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION validate_v1_obligation_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  forward_prefix jsonb;
  expected_inverse jsonb;
  expected_plan_checksum text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'v1 rollback obligation cannot be deleted';
  END IF;
  IF NEW.workspace_id<>OLD.workspace_id OR NEW.authorization_id<>OLD.authorization_id
     OR NEW.execution_id<>OLD.execution_id OR NEW.obligation_id<>OLD.obligation_id
     OR NEW.authorization_fingerprint<>OLD.authorization_fingerprint
     OR NEW.prior_inventory_checksum<>OLD.prior_inventory_checksum
     OR NEW.inverse_protocol<>OLD.inverse_protocol OR NEW.inverse_operations<>OLD.inverse_operations
     OR NEW.opened_by_operation_id<>OLD.opened_by_operation_id
     OR NEW.opened_by_intent_checksum<>OLD.opened_by_intent_checksum
     OR NEW.opened_at<>OLD.opened_at THEN
    RAISE EXCEPTION 'v1 rollback obligation scope is immutable';
  END IF;
  IF OLD.state='open' AND NEW.state IN ('executing','human_intervention_required') THEN
    SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
      INTO forward_prefix
      FROM mission_agent_v1_provider_mutations m
     WHERE m.workspace_id=NEW.workspace_id AND m.authorization_id=NEW.authorization_id
       AND m.execution_id=NEW.execution_id AND m.phase='forward';
    expected_inverse := mission_agent_v1_rollback_plan(forward_prefix);
    expected_plan_checksum := encode(digest(convert_to(expected_inverse::text,'UTF8'),'sha256'),'hex');
    IF expected_inverse IS NULL OR NEW.required_inverse_operations<>expected_inverse
       OR NEW.rollback_plan_checksum<>expected_plan_checksum THEN
      RAISE EXCEPTION 'v1 rollback plan does not match the completed forward prefix';
    END IF;
  ELSIF NEW.required_inverse_operations IS DISTINCT FROM OLD.required_inverse_operations
     OR NEW.rollback_plan_checksum IS DISTINCT FROM OLD.rollback_plan_checksum THEN
    RAISE EXCEPTION 'v1 rollback plan is immutable after derivation';
  END IF;
  IF NEW.state='verified_closed' AND NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_closure_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id
       AND e.outcome=NEW.closure_outcome
       AND e.evidence_checksum=NEW.closure_evidence_checksum
  ) THEN
    RAISE EXCEPTION 'rollback closure requires canonical evidence';
  END IF;
  IF NEW.state='verified_closed' AND EXISTS (
    SELECT 1 FROM mission_agent_v1_provider_mutations m
     WHERE m.workspace_id=NEW.workspace_id AND m.authorization_id=NEW.authorization_id
       AND m.execution_id=NEW.execution_id
       AND NOT EXISTS (
         SELECT 1 FROM mission_agent_v1_provider_receipts r
          WHERE r.workspace_id=m.workspace_id AND r.authorization_id=m.authorization_id
            AND r.execution_id=m.execution_id AND r.provider_mutation_id=m.provider_mutation_id
       )
  ) THEN
    RAISE EXCEPTION 'rollback closure requires every provider receipt';
  END IF;
  IF NEW.state='verified_closed' AND EXISTS (
    SELECT 1 FROM mission_agent_v1_closure_evidence e
     WHERE e.workspace_id=NEW.workspace_id AND e.authorization_id=NEW.authorization_id
       AND e.execution_id=NEW.execution_id AND e.evidence_checksum=NEW.closure_evidence_checksum
       AND e.outcome='rollback_verified' AND NEW.closure_outcome='rollback_verified'
       AND (
         SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
           FROM mission_agent_v1_provider_mutations m
          WHERE m.workspace_id=NEW.workspace_id AND m.authorization_id=NEW.authorization_id
            AND m.execution_id=NEW.execution_id AND m.phase='rollback'
       ) <> NEW.required_inverse_operations
  ) THEN
    RAISE EXCEPTION 'rollback closure requires the exact inverse mutation sequence';
  END IF;
  IF NOT (
    (OLD.state='open' AND NEW.state IN ('executing','human_intervention_required','verified_closed')) OR
    (OLD.state='executing' AND NEW.state IN ('human_intervention_required','verified_closed')) OR
    (OLD.state='human_intervention_required' AND NEW.state IN ('executing','verified_closed')) OR
    OLD.state=NEW.state
  ) THEN
    RAISE EXCEPTION 'invalid rollback obligation transition';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_agent_v1_obligation_guard
BEFORE UPDATE OR DELETE ON mission_agent_v1_rollback_obligations
FOR EACH ROW EXECUTE FUNCTION validate_v1_obligation_change();

CREATE OR REPLACE FUNCTION close_mission_agent_v1_rollout(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_outcome text,
  p_process_checksum text,
  p_heartbeat_checksum text,
  p_projection_checksum text,
  p_inventory_checksum text
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  obligation record;
  evidence_document jsonb;
  evidence_bytes text;
  closure_checksum text;
  verified_time timestamptz := clock_timestamp();
BEGIN
  IF p_outcome NOT IN ('success_verified','rollback_verified') THEN
    RAISE EXCEPTION 'v1 closure outcome is invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || p_authorization_id::text || ':' || p_execution_id::text,0
  ));
  SELECT * INTO obligation
    FROM mission_agent_v1_rollback_obligations
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
     AND execution_id=p_execution_id
   FOR UPDATE;
  IF obligation IS NULL OR obligation.state='verified_closed' THEN
    RAISE EXCEPTION 'v1 rollback obligation is unavailable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
       AND e.execution_id=p_execution_id AND e.evidence_type='process'
       AND e.evidence_checksum=p_process_checksum AND e.expires_at>verified_time
  ) OR NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
       AND e.execution_id=p_execution_id AND e.evidence_type='heartbeat-capability'
       AND e.evidence_checksum=p_heartbeat_checksum AND e.expires_at>verified_time
  ) OR NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
       AND e.execution_id=p_execution_id AND e.evidence_type='projection'
       AND e.evidence_checksum=p_projection_checksum AND e.expires_at>verified_time
  ) OR NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_verified_evidence e
     WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
       AND e.execution_id=p_execution_id
       AND e.evidence_type=CASE WHEN p_outcome='success_verified' THEN 'smoke' ELSE 'rollback-equivalence' END
       AND e.evidence_checksum=p_inventory_checksum AND e.expires_at>verified_time
  ) THEN
    RAISE EXCEPTION 'v1 closure lacks fresh verifier evidence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM mission_agent_v1_provider_mutations m
     WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
       AND m.execution_id=p_execution_id
       AND NOT EXISTS (
         SELECT 1 FROM mission_agent_v1_provider_receipts r
          WHERE r.workspace_id=m.workspace_id AND r.authorization_id=m.authorization_id
            AND r.execution_id=m.execution_id AND r.provider_mutation_id=m.provider_mutation_id
       )
  ) THEN
    RAISE EXCEPTION 'v1 closure requires every provider receipt';
  END IF;
  IF p_outcome='rollback_verified' AND (
    SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
      FROM mission_agent_v1_provider_mutations m
     WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
       AND m.execution_id=p_execution_id AND m.phase='rollback'
  ) <> obligation.required_inverse_operations THEN
    RAISE EXCEPTION 'v1 rollback closure requires exact inverse mutation sequence';
  END IF;
  evidence_document := jsonb_build_object(
    'authorization_id',p_authorization_id,
    'execution_id',p_execution_id,
    'heartbeat_capability_checksum',p_heartbeat_checksum,
    'inventory_checksum',p_inventory_checksum,
    'outcome',p_outcome,
    'process_checksum',p_process_checksum,
    'projection_checksum',p_projection_checksum,
    'workspace_id',p_workspace_id
  );
  evidence_bytes := evidence_document::text;
  closure_checksum := encode(digest(convert_to(evidence_bytes,'UTF8'),'sha256'),'hex');
  INSERT INTO mission_agent_v1_closure_evidence(
    workspace_id,authorization_id,execution_id,outcome,evidence_checksum,process_checksum,
    heartbeat_checksum,capability_checksum,projection_checksum,inventory_checksum,
    evidence_bytes,verified_at
  ) VALUES(
    p_workspace_id,p_authorization_id,p_execution_id,p_outcome,closure_checksum,p_process_checksum,
    p_heartbeat_checksum,p_heartbeat_checksum,p_projection_checksum,p_inventory_checksum,
    evidence_bytes,verified_time
  );
  UPDATE mission_agent_v1_rollback_obligations
     SET state='verified_closed',closed_at=verified_time,closure_outcome=p_outcome,
         closure_evidence_checksum=closure_checksum
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
     AND execution_id=p_execution_id AND obligation_id=obligation.obligation_id;
  UPDATE mission_agent_v1_rollout_operations
     SET state=p_outcome,terminal_evidence_checksum=closure_checksum,updated_at=verified_time
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
     AND execution_id=p_execution_id;
  RETURN closure_checksum;
END $$;

REVOKE ALL ON FUNCTION close_mission_agent_v1_rollout(
  uuid,uuid,uuid,text,text,text,text,text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION close_mission_agent_v1_rollout(
  uuid,uuid,uuid,text,text,text,text,text
) FROM mission_control_v1_verifier,mission_control_v1_controller,mission_control_v1_runtime;

CREATE OR REPLACE FUNCTION execute_mission_agent_v1_handler(
  p_workspace_id uuid,
  p_credential_id uuid,
  p_agent_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_handler text,
  p_action text,
  p_payload jsonb,
  p_request_message_id uuid,
  p_request_nonce text,
  p_request_body_checksum text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  rollout record;
  grant_row record;
  intent_row record;
  obligation_row record;
  transition_row record;
  phase_name text;
  phase_number integer;
  receipt_text text;
  receipt_digest text;
  transition_binding jsonb;
  expected_operation text;
  v_closure_outcome text;
  closure_document jsonb;
  closure_bytes text;
  closure_checksum text;
  transition_fence bigint;
BEGIN
  IF p_handler NOT IN ('claim','intent','receipt','decision','status','failure')
     OR p_request_body_checksum !~ '^[a-f0-9]{64}$'
     OR p_request_nonce='' THEN
    RAISE EXCEPTION 'v1 handler envelope is invalid';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text||':'||p_authorization_id::text||':'||p_execution_id::text,0
  ));
  SELECT r.*,o.credential_id,o.host_id,o.executable_checksum,
         release.artifact_checksum operator_artifact_checksum,
         host.public_key_fingerprint host_fingerprint,
         c.version configuration_version,
         coalesce((SELECT max(f.epoch) FROM mission_agent_v1_fencing_epochs f
           WHERE f.workspace_id=r.workspace_id AND f.authorization_id=r.authorization_id
             AND f.execution_id=r.execution_id AND f.fencing_namespace=r.fencing_namespace),0) current_fence
    INTO rollout
    FROM mission_agent_v1_rollout_operations r
    JOIN mission_agent_v1_operator_identities o
      ON o.workspace_id=r.workspace_id AND o.operator_id=r.operator_id
      AND o.agent_id=r.agent_id AND o.host_id=r.host_id
    JOIN mission_agent_v1_operator_releases release
      ON release.release_id=o.operator_release_id AND release.status='approved'
    JOIN mission_agent_v1_host_identities host
      ON host.workspace_id=o.workspace_id AND host.host_id=o.host_id AND host.status='active'
    JOIN mission_control_v1_production_configurations c
      ON c.configuration_id=r.configuration_id
   WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
     AND r.execution_id=p_execution_id
   FOR UPDATE OF r;
  IF rollout IS NULL OR rollout.credential_id<>p_credential_id OR rollout.agent_id<>p_agent_id
     OR rollout.authorization_fingerprint<>p_payload->>'authorizationFingerprint' THEN
    RAISE EXCEPTION 'v1 handler identity is contradictory';
  END IF;
  IF p_handler='receipt' AND p_action='accept_provider_receipt'
     AND EXISTS (
       SELECT 1 FROM mission_agent_v1_provider_receipts r
        WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
          AND r.execution_id=p_execution_id
          AND r.provider_mutation_id=(p_payload->>'providerMutationId')::uuid
     ) THEN
    SELECT * INTO grant_row FROM mission_agent_v1_provider_receipts r
     WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
       AND r.execution_id=p_execution_id
       AND r.provider_mutation_id=(p_payload->>'providerMutationId')::uuid;
    IF grant_row.receipt_checksum<>p_payload->>'receiptChecksum' THEN
      RAISE EXCEPTION 'v1 provider receipt retry contradicts durable evidence';
    END IF;
    RETURN jsonb_build_object(
      'state',rollout.state,'sequence',rollout.lifecycle_sequence,
      'receiptChecksum',grant_row.receipt_checksum,'recovered',true
    );
  END IF;
  IF p_handler='status' AND p_action='operator_journal_head'
     AND EXISTS (
       SELECT 1 FROM mission_agent_v1_operator_confirmations c
        JOIN mission_agent_v1_grants g
          ON g.workspace_id=c.workspace_id AND g.authorization_id=c.authorization_id
         AND g.execution_id=c.execution_id AND g.provider_mutation_id=c.provider_mutation_id
        WHERE c.workspace_id=p_workspace_id AND c.authorization_id=p_authorization_id
          AND c.execution_id=p_execution_id AND g.grant_id=(p_payload->>'grantId')::uuid
     ) THEN
    SELECT * INTO grant_row FROM mission_agent_v1_operator_confirmations c
     WHERE c.workspace_id=p_workspace_id AND c.authorization_id=p_authorization_id
       AND c.execution_id=p_execution_id
       AND c.provider_mutation_id=(
         SELECT g.provider_mutation_id FROM mission_agent_v1_grants g
          WHERE g.workspace_id=p_workspace_id AND g.authorization_id=p_authorization_id
            AND g.execution_id=p_execution_id AND g.grant_id=(p_payload->>'grantId')::uuid
       );
    IF grant_row.request_checksum<>p_payload->>'operatorRequestChecksum'
       OR grant_row.operator_journal_checksum<>p_payload->>'operatorJournalChecksum' THEN
      RAISE EXCEPTION 'v1 operator journal retry contradicts durable intent';
    END IF;
    RETURN jsonb_build_object(
      'state',rollout.state,'sequence',rollout.lifecycle_sequence,
      'operatorJournalChecksum',grant_row.operator_journal_checksum,'recovered',true
    );
  END IF;
  IF rollout.lifecycle_sequence<>(p_payload->>'expectedSequence')::bigint
     OR rollout.state<>p_payload->>'expectedState'
     OR (
       rollout.current_fence<>(p_payload->>'fencingGeneration')::bigint
       AND NOT (
         p_handler='receipt' AND p_action='accept_provider_receipt'
         AND EXISTS (
           SELECT 1 FROM mission_agent_v1_grants historical_grant
            WHERE historical_grant.workspace_id=p_workspace_id
              AND historical_grant.authorization_id=p_authorization_id
              AND historical_grant.execution_id=p_execution_id
              AND historical_grant.grant_id=(p_payload->>'grantId')::uuid
              AND historical_grant.fencing_generation=(p_payload->>'fencingGeneration')::bigint
         )
       )
     ) THEN
    RAISE EXCEPTION 'v1 handler identity, state, sequence, or fence is contradictory';
  END IF;
  transition_fence:=rollout.current_fence;
  transition_binding := jsonb_build_object(
    'authorizationFingerprint',rollout.authorization_fingerprint,
    'operatorId',rollout.operator_id,
    'hostId',rollout.host_id,
    'operatorArtifactSha256',rollout.executable_checksum,
    'agentId',rollout.agent_id,
    'targetArtifactSha256',rollout.target_artifact_checksum,
    'originatingForwardDeploymentId',rollout.deployment_id,
    'currentControllerDeploymentId',rollout.current_controller_deployment_id,
    'configurationVersion',rollout.configuration_version
  );

  IF p_handler='claim' AND p_action='verify_drain' THEN
    IF p_payload->>'drainEvidenceChecksum' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'v1 drain verification evidence is malformed';
    END IF;
    UPDATE mission_agent_v1_rollout_operations
       SET drain_evidence_checksum=p_payload->>'drainEvidenceChecksum'
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id;
  ELSIF p_handler='intent' AND p_action='propose_grant' THEN
    IF p_payload->>'grantKind'='forward' THEN
      SELECT (ARRAY['stage_artifact','stop_agent','install_agent','install_launch_configuration','start_agent'])
             [count(*)::int+1]
        INTO expected_operation
        FROM mission_agent_v1_provider_mutations
       WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
         AND execution_id=p_execution_id AND phase='forward';
    ELSE
      SELECT o.required_inverse_operations->>(count(m.*)::int)
        INTO expected_operation
        FROM mission_agent_v1_rollback_obligations o
        LEFT JOIN mission_agent_v1_provider_mutations m
          ON m.workspace_id=o.workspace_id AND m.authorization_id=o.authorization_id
         AND m.execution_id=o.execution_id AND m.phase='rollback'
       WHERE o.workspace_id=p_workspace_id AND o.authorization_id=p_authorization_id
         AND o.execution_id=p_execution_id AND o.obligation_id=rollout.rollback_obligation_id
       GROUP BY o.required_inverse_operations;
    END IF;
    IF (p_payload->>'grantChecksum') !~ '^[a-f0-9]{64}$'
       OR encode(digest(convert_to(p_payload->>'grantBytes','UTF8'),'sha256'),'hex')<>p_payload->>'grantChecksum'
       OR (p_payload->>'grantExpiresAt')::timestamptz<=clock_timestamp()
       OR (p_payload->>'grantExpiresAt')::timestamptz>clock_timestamp()+interval '15 minutes'
       OR (p_payload->>'grantKind'='forward' AND clock_timestamp()>=rollout.forward_expires_at)
       OR expected_operation IS NULL OR expected_operation<>p_payload->>'operation'
       OR (p_payload->>'grantKind' IN ('rollback','recovery') AND NOT EXISTS (
         SELECT 1 FROM mission_agent_v1_rollback_obligations o
          WHERE o.workspace_id=p_workspace_id AND o.authorization_id=p_authorization_id
            AND o.execution_id=p_execution_id AND o.obligation_id=rollout.rollback_obligation_id
            AND o.state IN ('open','executing','human_intervention_required')
       )) THEN
      RAISE EXCEPTION 'v1 grant authority is unavailable';
    END IF;
    INSERT INTO mission_agent_v1_grants(
      workspace_id,authorization_id,execution_id,grant_id,grant_kind,state,operation_id,
      provider_mutation_id,operation,sequence,authorization_fingerprint,operator_id,host_id,
      agent_id,operator_artifact_checksum,target_artifact_checksum,
      originating_forward_deployment_id,current_controller_deployment_id,configuration_id,
      fencing_generation,rollback_obligation_id,grant_checksum,grant_bytes,issued_at,expires_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,(p_payload->>'grantId')::uuid,
      p_payload->>'grantKind','issued',(p_payload->>'operationId')::uuid,
      (p_payload->>'providerMutationId')::uuid,p_payload->>'operation',
      (p_payload->>'operationSequence')::bigint,rollout.authorization_fingerprint,
      rollout.operator_id,rollout.host_id,rollout.agent_id,rollout.executable_checksum,
      rollout.target_artifact_checksum,rollout.deployment_id,rollout.current_controller_deployment_id,
      rollout.configuration_id,rollout.current_fence,rollout.rollback_obligation_id,
      p_payload->>'grantChecksum',p_payload->>'grantBytes',clock_timestamp(),
      (p_payload->>'grantExpiresAt')::timestamptz
    );
  ELSIF p_handler='status' AND p_action IN ('record_grant_delivery','acknowledge_grant') THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    IF grant_row IS NULL OR grant_row.grant_checksum<>p_payload->>'grantChecksum'
       OR grant_row.fencing_generation<>rollout.current_fence
       OR grant_row.expires_at<=clock_timestamp()
       OR (p_action='record_grant_delivery' AND grant_row.state<>'issued')
       OR (p_action='acknowledge_grant' AND grant_row.state<>'delivered') THEN
      RAISE EXCEPTION 'v1 grant acknowledgement is contradictory';
    END IF;
    IF p_action='record_grant_delivery' THEN
      UPDATE mission_agent_v1_grants SET state='delivered',delivery_message_id=p_request_message_id,
        delivered_at=clock_timestamp()
       WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
         AND execution_id=p_execution_id AND grant_id=grant_row.grant_id;
    ELSE
      IF p_payload->>'acknowledgementChecksum' !~ '^[a-f0-9]{64}$'
         OR p_payload->>'operatorJournalChecksum' !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'v1 grant acknowledgement evidence is malformed';
      END IF;
      UPDATE mission_agent_v1_grants SET state='acknowledged',
        acknowledgement_message_id=p_request_message_id,
        acknowledgement_checksum=p_payload->>'acknowledgementChecksum',
        host_acknowledgement_signature=p_payload->>'hostSignature',
        acknowledged_at=clock_timestamp()
       WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
         AND execution_id=p_execution_id AND grant_id=grant_row.grant_id;
      UPDATE mission_agent_v1_rollout_operations
         SET operator_journal_checksum=p_payload->>'operatorJournalChecksum'
       WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
         AND execution_id=p_execution_id;
    END IF;
  ELSIF p_handler='decision' AND p_action IN ('expire_grant','revoke_grant') THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    IF grant_row IS NULL OR grant_row.grant_checksum<>p_payload->>'grantChecksum'
       OR grant_row.state NOT IN ('issued','delivered','acknowledged')
       OR EXISTS (
         SELECT 1 FROM mission_agent_v1_operator_confirmations c
          WHERE c.workspace_id=grant_row.workspace_id
            AND c.authorization_id=grant_row.authorization_id
            AND c.execution_id=grant_row.execution_id
            AND c.provider_mutation_id=grant_row.provider_mutation_id
       )
       OR (p_action='expire_grant' AND grant_row.expires_at>clock_timestamp())
       OR (p_action='revoke_grant'
         AND p_payload->>'revocationReasonChecksum' !~ '^[a-f0-9]{64}$') THEN
      RAISE EXCEPTION 'v1 grant expiration or revocation is contradictory';
    END IF;
    UPDATE mission_agent_v1_grants
       SET state=CASE WHEN p_action='expire_grant'
                      THEN 'expired_before_consumption'
                      ELSE 'revoked_before_consumption' END
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=grant_row.grant_id;
  ELSIF p_handler='intent' AND p_action='commit_mutation_intent' THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    IF grant_row IS NULL OR grant_row.state<>'acknowledged'
       OR grant_row.operation_id<>(p_payload->>'operationId')::uuid
       OR grant_row.operation<>p_payload->>'operation'
       OR grant_row.expires_at<=clock_timestamp()
       OR (grant_row.grant_kind='forward' AND clock_timestamp()>=rollout.forward_expires_at) THEN
      RAISE EXCEPTION 'v1 mutation intent lacks an acknowledged valid grant';
    END IF;
    INSERT INTO mission_agent_replacement_mutation_intents(
      workspace_id,authorization_id,execution_id,operation_id,credential_id,claim_generation,
      sequence,operation,fixed_arguments_checksum,expected_precondition_checksum,
      expected_postcondition_checksum,from_state,to_state,retry_policy,rollback_obligation,
      intent_checksum,status,created_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.operation_id,p_credential_id,1,
      grant_row.sequence,grant_row.operation,p_payload->>'fixedArgumentsChecksum',
      p_payload->>'expectedPreconditionChecksum',p_payload->>'expectedPostconditionChecksum',
      p_payload->>'fromState',p_payload->>'toState','inspect-then-once',true,
      p_payload->>'intentChecksum','prepared',clock_timestamp()
    );
    IF grant_row.grant_kind='forward' THEN
      INSERT INTO mission_agent_v1_rollback_obligations(
        workspace_id,authorization_id,execution_id,obligation_id,authorization_fingerprint,
        prior_inventory_checksum,inverse_protocol,inverse_operations,opened_by_operation_id,
        opened_by_intent_checksum,state
      ) VALUES(
        p_workspace_id,p_authorization_id,p_execution_id,rollout.rollback_obligation_id,
        rollout.authorization_fingerprint,rollout.prior_inventory_checksum,
        'mission-agent-v1-rollback-sequence-v1','[
          "remove_staged_artifact","stop_agent","restore_previous_version",
          "restore_previous_launch_configuration","install_launch_configuration","start_agent",
          "verify_process","collect_heartbeats","verify_capabilities","verify_rollback"
        ]'::jsonb,grant_row.operation_id,p_payload->>'intentChecksum','open'
      ) ON CONFLICT(workspace_id,authorization_id,execution_id,obligation_id) DO NOTHING;
      UPDATE mission_agent_v1_rollout_operations SET forward_consumed_at=coalesce(forward_consumed_at,clock_timestamp())
       WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id AND execution_id=p_execution_id;
    END IF;
  ELSIF p_handler='status' AND p_action='operator_journal_head' THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    IF grant_row IS NULL OR grant_row.state<>'acknowledged'
       OR grant_row.expires_at<=clock_timestamp()
       OR p_payload->>'operatorJournalChecksum' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'v1 operator journal intent is unavailable';
    END IF;
    INSERT INTO mission_agent_v1_operator_confirmations(
      workspace_id,authorization_id,execution_id,provider_mutation_id,operation,sequence,
      fencing_generation,request_checksum,request_message_id,request_nonce,
      authenticated_message_id,authenticated_nonce,prior_operator_journal_checksum,
      operator_journal_checksum,confirmed_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.provider_mutation_id,
      grant_row.operation,grant_row.sequence,rollout.current_fence,p_payload->>'operatorRequestChecksum',
      (p_payload->>'operatorRequestMessageId')::uuid,p_payload->>'operatorRequestNonce',
      p_request_message_id,p_request_nonce,rollout.operator_journal_checksum,
      p_payload->>'operatorJournalChecksum',clock_timestamp()
    );
    UPDATE mission_agent_v1_rollout_operations SET operator_journal_checksum=p_payload->>'operatorJournalChecksum'
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id AND execution_id=p_execution_id;
  ELSIF p_handler='status' AND p_action='anchor_durable_receipt' THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    IF grant_row IS NULL OR grant_row.state<>'acknowledged'
       OR grant_row.provider_mutation_id<>(p_payload->>'providerMutationId')::uuid
       OR grant_row.fencing_generation<>rollout.current_fence
       OR p_payload->>'receiptChecksum' !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
         SELECT 1 FROM mission_agent_v1_operator_confirmations c
          WHERE c.workspace_id=p_workspace_id AND c.authorization_id=p_authorization_id
            AND c.execution_id=p_execution_id
            AND c.provider_mutation_id=grant_row.provider_mutation_id
            AND c.fencing_generation=grant_row.fencing_generation
       ) THEN
      RAISE EXCEPTION 'v1 durable receipt anchor is invalid or stale';
    END IF;
    INSERT INTO mission_agent_v1_durable_receipt_anchors(
      workspace_id,authorization_id,execution_id,grant_id,provider_mutation_id,
      fencing_generation,receipt_checksum,host_signature,request_message_id,request_nonce
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.grant_id,
      grant_row.provider_mutation_id,grant_row.fencing_generation,p_payload->>'receiptChecksum',
      p_payload->>'hostSignature',p_request_message_id,p_request_nonce
    );
  ELSIF p_handler='receipt' AND p_action='accept_provider_receipt' THEN
    SELECT * INTO grant_row FROM mission_agent_v1_grants
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=(p_payload->>'grantId')::uuid
     FOR UPDATE;
    SELECT * INTO intent_row FROM mission_agent_replacement_mutation_intents
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND operation_id=grant_row.operation_id
     FOR UPDATE;
    SELECT * INTO obligation_row FROM mission_agent_v1_rollback_obligations
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND obligation_id=rollout.rollback_obligation_id
     FOR UPDATE;
    receipt_text:=p_payload->>'receiptBytes';
    receipt_digest:=encode(digest(convert_to(receipt_text,'UTF8'),'sha256'),'hex');
    IF grant_row IS NULL OR intent_row IS NULL OR obligation_row IS NULL
       OR grant_row.state<>'acknowledged' OR intent_row.status<>'prepared'
       OR (
         grant_row.expires_at<=clock_timestamp()
         AND (p_payload->>'executedAt')::timestamptz>grant_row.expires_at
       )
       OR receipt_digest<>p_payload->>'receiptChecksum'
       OR (p_payload->>'providerMutationId')::uuid<>grant_row.provider_mutation_id
       OR p_payload->>'operation'<>grant_row.operation
       OR (p_payload->>'priorStateChecksum') !~ '^[a-f0-9]{64}$'
       OR (p_payload->>'resultingStateChecksum') !~ '^[a-f0-9]{64}$'
       OR p_payload->>'outcome'<>'succeeded'
       OR (p_payload->>'authenticatedReceiptTag') !~ '^[a-f0-9]{64}$'
       OR NOT EXISTS (
         SELECT 1 FROM mission_agent_v1_operator_confirmations c
          WHERE c.workspace_id=p_workspace_id AND c.authorization_id=p_authorization_id
            AND c.execution_id=p_execution_id
            AND c.provider_mutation_id=grant_row.provider_mutation_id
            AND c.operation=grant_row.operation AND c.sequence=grant_row.sequence
            AND c.fencing_generation=grant_row.fencing_generation
            AND c.request_message_id=(p_payload->>'operatorRequestMessageId')::uuid
            AND c.request_nonce=p_payload->>'operatorRequestNonce'
            AND c.operator_journal_checksum=p_payload->>'priorOperatorJournalChecksum'
       )
       OR (
         grant_row.fencing_generation<>rollout.current_fence
         AND NOT EXISTS (
           SELECT 1 FROM mission_agent_v1_durable_receipt_anchors a
            WHERE a.workspace_id=p_workspace_id AND a.authorization_id=p_authorization_id
              AND a.execution_id=p_execution_id AND a.grant_id=grant_row.grant_id
              AND a.provider_mutation_id=grant_row.provider_mutation_id
              AND a.fencing_generation=grant_row.fencing_generation
              AND a.receipt_checksum=receipt_digest
              AND a.anchored_at<(
                SELECT created_at FROM mission_agent_v1_fencing_epochs f
                 WHERE f.workspace_id=p_workspace_id AND f.authorization_id=p_authorization_id
                   AND f.execution_id=p_execution_id AND f.fencing_namespace=rollout.fencing_namespace
                   AND f.epoch=rollout.current_fence
              )
         )
       ) THEN
      RAISE EXCEPTION 'v1 durable provider receipt is invalid or contradictory';
    END IF;
    phase_name:=CASE WHEN grant_row.grant_kind='forward' THEN 'forward' ELSE 'rollback' END;
    SELECT count(*)::integer+1 INTO phase_number FROM mission_agent_v1_provider_mutations
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND phase=phase_name;
    INSERT INTO mission_agent_replacement_receipts(
      workspace_id,authorization_id,execution_id,operation_id,credential_id,agent_id,
      provider_identifier,authorization_fingerprint,claim_generation,sequence,request_nonce,
      receipt_nonce,operation,operation_checksum,result_checksum,host_journal_checksum,
      authentication_tag,received_at,acknowledgement
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.operation_id,p_credential_id,
      rollout.agent_id,'v1-macos-operator',rollout.authorization_fingerprint,1,grant_row.sequence,
      p_payload->>'operatorRequestNonce',p_request_nonce,grant_row.operation,
      p_request_body_checksum,p_payload->>'resultingStateChecksum',
      p_payload->>'operatorJournalChecksum',p_payload->>'authenticatedReceiptTag',
      clock_timestamp(),jsonb_build_object('accepted',true,'receiptChecksum',receipt_digest)
    );
    INSERT INTO mission_agent_v1_provider_mutations(
      workspace_id,authorization_id,execution_id,provider_mutation_id,grant_id,operation_id,
      obligation_id,authorization_fingerprint,prior_inventory_checksum,phase,phase_sequence,
      operation,sequence,fencing_namespace,fencing_epoch,intent_checksum,request_checksum,
      request_message_id,request_nonce,prior_operator_journal_checksum,operator_journal_checksum,
      prior_state_checksum,resulting_state_checksum,receipt_checksum,local_journal_entry_id,completed_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.provider_mutation_id,grant_row.grant_id,
      grant_row.operation_id,rollout.rollback_obligation_id,rollout.authorization_fingerprint,
      rollout.prior_inventory_checksum,phase_name,phase_number,grant_row.operation,grant_row.sequence,
      rollout.fencing_namespace,grant_row.fencing_generation,intent_row.intent_checksum,
      p_request_body_checksum,(p_payload->>'operatorRequestMessageId')::uuid,
      p_payload->>'operatorRequestNonce',p_payload->>'priorOperatorJournalChecksum',
      p_payload->>'operatorJournalChecksum',p_payload->>'priorStateChecksum',
      p_payload->>'resultingStateChecksum',receipt_digest,(p_payload->>'localJournalEntryId')::uuid,
      (p_payload->>'executedAt')::timestamptz
    );
    INSERT INTO mission_agent_v1_provider_receipts(
      workspace_id,authorization_id,execution_id,provider_mutation_id,grant_id,operation_id,
      operation,authorization_fingerprint,fencing_generation,sequence,operator_id,host_id,
      operator_artifact_checksum,agent_id,target_artifact_checksum,prior_state_checksum,
      resulting_state_checksum,local_journal_entry_id,executed_at,request_message_id,
      receipt_message_id,outcome,error_classification,receipt_checksum,receipt_bytes,
      authenticated_receipt_tag,host_receipt_signature,verification_evidence_checksum
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,grant_row.provider_mutation_id,grant_row.grant_id,
      grant_row.operation_id,grant_row.operation,rollout.authorization_fingerprint,grant_row.fencing_generation,
      grant_row.sequence,rollout.operator_id,rollout.host_id,rollout.executable_checksum,rollout.agent_id,
      rollout.target_artifact_checksum,p_payload->>'priorStateChecksum',
      p_payload->>'resultingStateChecksum',(p_payload->>'localJournalEntryId')::uuid,
      (p_payload->>'executedAt')::timestamptz,(p_payload->>'operatorRequestMessageId')::uuid,
      p_request_message_id,p_payload->>'outcome',p_payload->>'errorClassification',
      receipt_digest,receipt_text,p_payload->>'authenticatedReceiptTag',
      p_payload->>'hostSignature',p_payload->>'verificationEvidenceChecksum'
    );
    UPDATE mission_agent_v1_grants SET state='consumed',consumed_at=clock_timestamp()
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND grant_id=grant_row.grant_id;
    UPDATE mission_agent_replacement_mutation_intents SET status='completed',
      completed_at=clock_timestamp(),result_checksum=p_payload->>'resultingStateChecksum',
      host_journal_checksum=p_payload->>'operatorJournalChecksum'
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND operation_id=grant_row.operation_id;
  ELSIF p_handler='failure' AND p_action='activate_rollback' THEN
    SELECT * INTO obligation_row FROM mission_agent_v1_rollback_obligations
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND obligation_id=rollout.rollback_obligation_id
     FOR UPDATE;
    IF obligation_row IS NULL OR obligation_row.state='verified_closed' THEN
      RAISE EXCEPTION 'v1 durable rollback obligation is unavailable';
    END IF;
    UPDATE mission_agent_v1_rollback_obligations SET state='executing',
      required_inverse_operations=mission_agent_v1_rollback_plan((
        SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
          FROM mission_agent_v1_provider_mutations m
         WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
           AND m.execution_id=p_execution_id AND m.phase='forward'
      )),
      rollback_plan_checksum=encode(digest(convert_to(mission_agent_v1_rollback_plan((
        SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
          FROM mission_agent_v1_provider_mutations m
         WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
           AND m.execution_id=p_execution_id AND m.phase='forward'
      ))::text,'UTF8'),'sha256'),'hex')
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND obligation_id=rollout.rollback_obligation_id;
  ELSIF p_handler='decision' AND p_action='observe_stability' THEN
    UPDATE mission_agent_replacement_execution_claims
       SET state='awaiting-authoritative-smoke'
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id;
  ELSIF p_handler='status' AND p_action='rollback_observation' THEN
    SELECT r.* INTO grant_row
      FROM mission_agent_v1_provider_receipts r
     WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
       AND r.execution_id=p_execution_id
       AND EXISTS (
         SELECT 1 FROM mission_agent_v1_provider_mutations m
          WHERE m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
            AND m.execution_id=r.execution_id AND m.provider_mutation_id=r.provider_mutation_id
            AND m.phase='rollback'
       )
     ORDER BY r.executed_at DESC,r.receipt_message_id DESC LIMIT 1;
    IF grant_row IS NULL
       OR jsonb_typeof(p_payload->'processEvidence')<>'object'
       OR (p_payload->>'observedAt')::timestamptz<=grant_row.executed_at
       OR (p_payload->>'observedAt')::timestamptz>clock_timestamp()+interval '5 minutes'
       OR p_payload->'processEvidence'->>'terminalReceiptChecksum'<>grant_row.receipt_checksum
       OR p_payload->'processEvidence'->>'terminalStateChecksum'<>grant_row.resulting_state_checksum
       OR (p_payload->'processEvidence'->>'fencingGeneration')::bigint<>rollout.current_fence
       OR p_payload->'processEvidence'->>'authorizationId'<>p_authorization_id::text
       OR p_payload->'processEvidence'->>'executionId'<>p_execution_id::text
       OR p_payload->'processEvidence'->>'hostSignature' IS NOT NULL THEN
      RAISE EXCEPTION 'v1 rollback host observation is invalid or stale';
    END IF;
    closure_document:=p_payload->'processEvidence';
    closure_checksum:=encode(digest(convert_to(closure_document::text,'UTF8'),'sha256'),'hex');
    INSERT INTO mission_agent_replacement_evidence(
      workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
      observed_at,expires_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,'process',closure_checksum,
      closure_document,(p_payload->>'observedAt')::timestamptz,clock_timestamp()+interval '15 minutes'
    );
  ELSIF p_handler='status' AND p_action='runtime_status' THEN
    IF p_payload->>'evidenceType' NOT IN (
      'process','heartbeat-capability','projection','smoke','rollback-equivalence'
    ) OR p_payload->>'sourceEvidenceChecksum' !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'v1 canonical runtime evidence reference is malformed';
    END IF;
    PERFORM record_mission_agent_v1_canonical_evidence(
      p_workspace_id,p_authorization_id,p_execution_id,p_payload->>'evidenceType',
      p_payload->>'sourceEvidenceChecksum'
    );
  ELSIF p_handler='decision' AND p_action IN ('close_success','close_rollback') THEN
    v_closure_outcome:=CASE WHEN p_action='close_success' THEN 'success_verified' ELSE 'rollback_verified' END;
    IF v_closure_outcome='rollback_verified' THEN
      closure_document:=p_payload->'rollbackEvidence';
      IF jsonb_typeof(closure_document)<>'object'
         OR (p_payload->>'rollbackEvidenceExpiresAt')::timestamptz<=clock_timestamp()
         OR (p_payload->>'rollbackEvidenceExpiresAt')::timestamptz>clock_timestamp()+interval '15 minutes'
         OR closure_document->>'authorizationId'<>p_authorization_id::text
         OR closure_document->>'executionId'<>p_execution_id::text
         OR closure_document->>'terminalReceiptChecksum'<>(
           SELECT r.receipt_checksum
             FROM mission_agent_v1_provider_receipts r
             JOIN mission_agent_v1_provider_mutations m
               ON m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
              AND m.execution_id=r.execution_id AND m.provider_mutation_id=r.provider_mutation_id
            WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
              AND r.execution_id=p_execution_id AND m.phase='rollback'
            ORDER BY r.executed_at DESC,r.receipt_message_id DESC LIMIT 1
         ) THEN
        RAISE EXCEPTION 'v1 rollback equivalence evidence is invalid';
      END IF;
      closure_checksum:=encode(digest(convert_to(closure_document::text,'UTF8'),'sha256'),'hex');
      INSERT INTO mission_agent_replacement_evidence(
        workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum,evidence,
        observed_at,expires_at
      ) VALUES
        (p_workspace_id,p_authorization_id,p_execution_id,'heartbeat-capability',
         closure_checksum,closure_document,clock_timestamp(),
         (p_payload->>'rollbackEvidenceExpiresAt')::timestamptz),
        (p_workspace_id,p_authorization_id,p_execution_id,'projection',
         closure_checksum,closure_document,clock_timestamp(),
         (p_payload->>'rollbackEvidenceExpiresAt')::timestamptz),
        (p_workspace_id,p_authorization_id,p_execution_id,'rollback-equivalence',
         closure_checksum,closure_document,clock_timestamp(),
         (p_payload->>'rollbackEvidenceExpiresAt')::timestamptz);
      FOR expected_operation IN SELECT unnest(ARRAY[
        'process','heartbeat-capability','projection','rollback-equivalence'
      ]) LOOP
        SELECT e.evidence_checksum INTO receipt_digest
          FROM mission_agent_replacement_evidence e
         WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
           AND e.execution_id=p_execution_id AND e.evidence_type=expected_operation
           AND e.expires_at>clock_timestamp()
           AND e.observed_at>(
             SELECT max(r.executed_at)
               FROM mission_agent_v1_provider_receipts r
               JOIN mission_agent_v1_provider_mutations m
                 ON m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                AND m.execution_id=r.execution_id AND m.provider_mutation_id=r.provider_mutation_id
              WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
                AND r.execution_id=p_execution_id AND m.phase='rollback'
           )
           AND (
             expected_operation<>'rollback-equivalence'
             OR e.evidence->>'terminalReceiptChecksum'=(
               SELECT r.receipt_checksum
                 FROM mission_agent_v1_provider_receipts r
                 JOIN mission_agent_v1_provider_mutations m
                   ON m.workspace_id=r.workspace_id AND m.authorization_id=r.authorization_id
                  AND m.execution_id=r.execution_id AND m.provider_mutation_id=r.provider_mutation_id
                WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
                  AND r.execution_id=p_execution_id AND m.phase='rollback'
                ORDER BY r.executed_at DESC,r.receipt_message_id DESC LIMIT 1
             )
           )
         ORDER BY e.observed_at DESC LIMIT 1;
        IF receipt_digest IS NULL THEN
          RAISE EXCEPTION 'v1 rollback lacks canonical runtime evidence';
        END IF;
        PERFORM record_mission_agent_v1_canonical_evidence(
          p_workspace_id,p_authorization_id,p_execution_id,expected_operation,receipt_digest
        );
        p_payload:=jsonb_set(
          p_payload,
          CASE expected_operation
            WHEN 'process' THEN '{processChecksum}'::text[]
            WHEN 'heartbeat-capability' THEN '{heartbeatChecksum}'::text[]
            WHEN 'projection' THEN '{projectionChecksum}'::text[]
            ELSE '{inventoryChecksum}'::text[]
          END,
          to_jsonb(receipt_digest)
        );
      END LOOP;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM mission_agent_v1_verified_evidence e
       WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
         AND e.execution_id=p_execution_id AND e.evidence_type='process'
         AND e.evidence_checksum=p_payload->>'processChecksum' AND e.expires_at>clock_timestamp()
    ) OR NOT EXISTS (
      SELECT 1 FROM mission_agent_v1_verified_evidence e
       WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
         AND e.execution_id=p_execution_id AND e.evidence_type='heartbeat-capability'
         AND e.evidence_checksum=p_payload->>'heartbeatChecksum' AND e.expires_at>clock_timestamp()
    ) OR NOT EXISTS (
      SELECT 1 FROM mission_agent_v1_verified_evidence e
       WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
         AND e.execution_id=p_execution_id AND e.evidence_type='projection'
         AND e.evidence_checksum=p_payload->>'projectionChecksum' AND e.expires_at>clock_timestamp()
    ) OR NOT EXISTS (
      SELECT 1 FROM mission_agent_v1_verified_evidence e
       WHERE e.workspace_id=p_workspace_id AND e.authorization_id=p_authorization_id
         AND e.execution_id=p_execution_id
         AND e.evidence_type=CASE WHEN v_closure_outcome='success_verified' THEN 'smoke' ELSE 'rollback-equivalence' END
         AND e.evidence_checksum=p_payload->>'inventoryChecksum' AND e.expires_at>clock_timestamp()
    ) OR EXISTS (
      SELECT 1 FROM mission_agent_v1_grants g
       WHERE g.workspace_id=p_workspace_id AND g.authorization_id=p_authorization_id
         AND g.execution_id=p_execution_id AND g.state NOT IN (
           'consumed','expired_before_consumption','revoked_before_consumption','superseded'
         )
    ) OR EXISTS (
      SELECT 1 FROM mission_agent_v1_provider_mutations m
       WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
         AND m.execution_id=p_execution_id AND NOT EXISTS (
           SELECT 1 FROM mission_agent_v1_provider_receipts r
            WHERE r.workspace_id=m.workspace_id AND r.authorization_id=m.authorization_id
              AND r.execution_id=m.execution_id AND r.provider_mutation_id=m.provider_mutation_id
         )
    ) THEN
      RAISE EXCEPTION 'v1 lifecycle closure lacks canonical durable verification';
    END IF;
    IF v_closure_outcome='success_verified' AND (
      SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
        FROM mission_agent_v1_provider_mutations m
       WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
         AND m.execution_id=p_execution_id AND m.phase='forward'
    ) <> '["stage_artifact","stop_agent","install_agent","install_launch_configuration","start_agent"]'::jsonb THEN
      RAISE EXCEPTION 'v1 success closure requires the complete canonical forward sequence';
    END IF;
    SELECT * INTO obligation_row FROM mission_agent_v1_rollback_obligations o
     WHERE o.workspace_id=p_workspace_id AND o.authorization_id=p_authorization_id
       AND o.execution_id=p_execution_id AND o.obligation_id=rollout.rollback_obligation_id
     FOR UPDATE;
    IF obligation_row IS NULL OR obligation_row.state='verified_closed'
       OR (v_closure_outcome='rollback_verified' AND (
         SELECT coalesce(jsonb_agg(m.operation ORDER BY m.phase_sequence),'[]'::jsonb)
           FROM mission_agent_v1_provider_mutations m
          WHERE m.workspace_id=p_workspace_id AND m.authorization_id=p_authorization_id
            AND m.execution_id=p_execution_id AND m.phase='rollback'
       )<>obligation_row.required_inverse_operations) THEN
      RAISE EXCEPTION 'v1 lifecycle closure cannot discharge its rollback obligation';
    END IF;
    closure_document:=jsonb_build_object(
      'authorization_id',p_authorization_id,'execution_id',p_execution_id,
      'heartbeat_capability_checksum',p_payload->>'heartbeatChecksum',
      'inventory_checksum',p_payload->>'inventoryChecksum','outcome',v_closure_outcome,
      'process_checksum',p_payload->>'processChecksum',
      'projection_checksum',p_payload->>'projectionChecksum','workspace_id',p_workspace_id
    );
    closure_bytes:=closure_document::text;
    closure_checksum:=encode(digest(convert_to(closure_bytes,'UTF8'),'sha256'),'hex');
    INSERT INTO mission_agent_v1_closure_evidence(
      workspace_id,authorization_id,execution_id,outcome,evidence_checksum,process_checksum,
      heartbeat_checksum,capability_checksum,projection_checksum,inventory_checksum,
      evidence_bytes,verified_at
    ) VALUES(
      p_workspace_id,p_authorization_id,p_execution_id,v_closure_outcome,closure_checksum,
      p_payload->>'processChecksum',p_payload->>'heartbeatChecksum',p_payload->>'heartbeatChecksum',
      p_payload->>'projectionChecksum',p_payload->>'inventoryChecksum',closure_bytes,clock_timestamp()
    );
    UPDATE mission_agent_v1_rollback_obligations
       SET state='verified_closed',closed_at=clock_timestamp(),closure_outcome=v_closure_outcome,
           closure_evidence_checksum=closure_checksum
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id AND obligation_id=rollout.rollback_obligation_id;
    UPDATE mission_agent_v1_rollout_operations SET terminal_evidence_checksum=closure_checksum
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id;
    UPDATE mission_agent_replacement_execution_claims
       SET state=CASE WHEN v_closure_outcome='success_verified' THEN 'completed' ELSE 'rolled-back' END,
           completed_at=clock_timestamp()
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
       AND execution_id=p_execution_id;
    UPDATE mission_agent_replacement_bootstraps
       SET state=CASE WHEN v_closure_outcome='success_verified' THEN 'completed' ELSE 'rolled_back' END,
           updated_at=clock_timestamp()
     WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id;
    UPDATE mission_agent_replacement_credentials SET consumed_at=coalesce(consumed_at,clock_timestamp())
     WHERE workspace_id=p_workspace_id AND credential_id=p_credential_id;
  END IF;

  SELECT * INTO transition_row FROM advance_mission_agent_v1_lifecycle(
    p_workspace_id,p_authorization_id,p_execution_id,p_handler,p_action,
    p_payload->>'expectedState',(p_payload->>'expectedSequence')::bigint,
    transition_fence,transition_binding,
    (p_payload->>'eventId')::uuid,p_request_message_id,p_request_nonce,
    'request-body-sha256:'||p_request_body_checksum
  );
  RETURN jsonb_build_object(
    'state',transition_row.state,'sequence',transition_row.sequence,
    'eventChecksum',transition_row.event_checksum,
    'grantId',p_payload->>'grantId','grantChecksum',p_payload->>'grantChecksum',
    'evidenceChecksum',CASE
      WHEN p_action='runtime_status' THEN p_payload->>'sourceEvidenceChecksum'
      WHEN p_action='rollback_observation' THEN closure_checksum
      ELSE NULL END
  );
END $$;

REVOKE ALL ON FUNCTION execute_mission_agent_v1_handler(
  uuid,uuid,uuid,uuid,uuid,text,text,jsonb,uuid,text,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_mission_agent_v1_handler(
  uuid,uuid,uuid,uuid,uuid,text,text,jsonb,uuid,text,text
) TO mission_control_v1_controller;

REVOKE INSERT,UPDATE,DELETE ON
  mission_agent_v1_rollout_operations,
  mission_agent_v1_grants,
  mission_agent_v1_lifecycle_events,
  mission_agent_v1_fencing_epochs,
  mission_agent_v1_rollback_obligations,
  mission_agent_v1_operator_confirmations,
  mission_agent_v1_durable_receipt_anchors,
  mission_agent_v1_provider_mutations,
  mission_agent_v1_provider_receipts,
  mission_agent_v1_closure_evidence,
  mission_agent_v1_verified_evidence
FROM PUBLIC,mission_control_v1_runtime,mission_control_v1_controller,mission_control_v1_verifier;

CREATE OR REPLACE FUNCTION adopt_mission_agent_v1_recovery_controller(
  p_workspace_id uuid,
  p_authorization_id uuid,
  p_execution_id uuid,
  p_new_deployment_id uuid,
  p_expected_fencing_generation bigint,
  p_request_message_id uuid,
  p_request_nonce text,
  p_evidence_checksum text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  rollout record;
  deployment record;
  next_generation bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text||':'||p_authorization_id::text||':'||p_execution_id::text,0
  ));
  SELECT r.*,c.configuration_checksum expected_configuration_checksum,
         coalesce((SELECT max(f.epoch) FROM mission_agent_v1_fencing_epochs f
           WHERE f.workspace_id=r.workspace_id AND f.authorization_id=r.authorization_id
             AND f.execution_id=r.execution_id AND f.fencing_namespace=r.fencing_namespace),0) current_fence
    INTO rollout
    FROM mission_agent_v1_rollout_operations r
    JOIN mission_control_v1_production_configurations c ON c.configuration_id=r.configuration_id
   WHERE r.workspace_id=p_workspace_id AND r.authorization_id=p_authorization_id
     AND r.execution_id=p_execution_id
   FOR UPDATE OF r;
  SELECT * INTO deployment FROM mission_control_production_deployments
   WHERE deployment_id=p_new_deployment_id;
  IF rollout IS NULL OR deployment IS NULL
     OR rollout.current_fence<>p_expected_fencing_generation
     OR deployment.attestation_expires_at<=clock_timestamp()
     OR deployment.configuration_checksum<>rollout.expected_configuration_checksum
     OR NOT EXISTS (
       SELECT 1 FROM mission_agent_v1_rollback_obligations o
        WHERE o.workspace_id=p_workspace_id AND o.authorization_id=p_authorization_id
          AND o.execution_id=p_execution_id AND o.state<>'verified_closed'
     )
     OR rollout.forward_consumed_at IS NULL
     OR rollout.state IN ('success_verified','rollback_verified','expired_before_mutation') THEN
    RAISE EXCEPTION 'v1 recovery controller adoption is unauthorized or contradictory';
  END IF;
  UPDATE mission_agent_v1_rollout_operations
     SET current_controller_deployment_id=p_new_deployment_id,updated_at=clock_timestamp()
   WHERE workspace_id=p_workspace_id AND authorization_id=p_authorization_id
     AND execution_id=p_execution_id;
  SELECT advance_mission_agent_v1_fencing_epoch(
    p_workspace_id,p_authorization_id,p_execution_id,rollout.fencing_namespace,
    p_expected_fencing_generation,deployment.task_arn,p_request_message_id,p_request_nonce,
    p_evidence_checksum
  ) INTO next_generation;
  RETURN next_generation;
END $$;

REVOKE ALL ON FUNCTION adopt_mission_agent_v1_recovery_controller(
  uuid,uuid,uuid,uuid,bigint,uuid,text,text
) FROM PUBLIC,mission_control_v1_runtime,mission_control_v1_verifier;
GRANT EXECUTE ON FUNCTION adopt_mission_agent_v1_recovery_controller(
  uuid,uuid,uuid,uuid,bigint,uuid,text,text
) TO mission_control_v1_controller;
