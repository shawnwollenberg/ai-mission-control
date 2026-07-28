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

CREATE TABLE mission_agent_v1_operator_identities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  deployment_id uuid NOT NULL REFERENCES mission_control_production_deployments(deployment_id) ON DELETE RESTRICT,
  implementation text NOT NULL CHECK(implementation = 'mission-agent-replacement-operator-v1'),
  version text NOT NULL,
  executable_checksum text NOT NULL CHECK(executable_checksum ~ '^[a-f0-9]{64}$'),
  executable_path text NOT NULL,
  owner_uid bigint NOT NULL CHECK(owner_uid > 0),
  journal_schema_version text NOT NULL CHECK(journal_schema_version = 'replacement-operator-journal-v1'),
  launch_agent_label text NOT NULL CHECK(launch_agent_label = 'com.wallyweb.mission-agent.replacement-operator'),
  credential_id uuid NOT NULL,
  verified_at timestamptz NOT NULL,
  verification_checksum text NOT NULL CHECK(verification_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,operator_id),
  UNIQUE(workspace_id,agent_id,operator_id,deployment_id),
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
  deployment_id uuid NOT NULL,
  configuration_id uuid NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  target_artifact_checksum text NOT NULL
    CHECK(target_artifact_checksum = '108e5587e8ffce0c37639e041cd2dcc2b51079f395beb04b26c1d4d9330bee09'),
  prior_inventory_checksum text NOT NULL CHECK(prior_inventory_checksum ~ '^[a-f0-9]{64}$'),
  claim_generation integer NOT NULL CHECK(claim_generation = 1),
  fencing_namespace uuid NOT NULL,
  initial_fencing_epoch bigint NOT NULL CHECK(initial_fencing_epoch = 1),
  state text NOT NULL CHECK(state IN (
    'prepared','drain_requested','drained_verified','forward_active','observing',
    'success_verified','recovery_only','rollback_verified','human_intervention_required',
    'expired_before_mutation'
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
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_replacement_execution_claims(workspace_id,authorization_id,execution_id)
      ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,agent_id,operator_id,deployment_id)
    REFERENCES mission_agent_v1_operator_identities(workspace_id,agent_id,operator_id,deployment_id)
      ON DELETE RESTRICT,
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
      JOIN mission_control_production_deployments d ON d.deployment_id=r.deployment_id
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

CREATE TABLE mission_agent_v1_provider_mutations (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  provider_mutation_id uuid NOT NULL,
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
  operator_journal_checksum text NOT NULL CHECK(operator_journal_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  UNIQUE(workspace_id,authorization_id,execution_id,phase,phase_sequence),
  UNIQUE(provider_mutation_id),
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
  operation_id uuid NOT NULL,
  receipt_checksum text NOT NULL CHECK(receipt_checksum ~ '^[a-f0-9]{64}$'),
  receipt_bytes text NOT NULL,
  authenticated_receipt_tag text NOT NULL CHECK(authenticated_receipt_tag ~ '^[a-f0-9]{64}$'),
  verification_evidence_checksum text NOT NULL CHECK(verification_evidence_checksum ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,provider_mutation_id),
  UNIQUE(receipt_checksum),
  FOREIGN KEY(workspace_id,authorization_id,execution_id,provider_mutation_id)
    REFERENCES mission_agent_v1_provider_mutations(
      workspace_id,authorization_id,execution_id,provider_mutation_id
    ) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,authorization_id,execution_id,operation_id)
    REFERENCES mission_agent_replacement_receipts(
      workspace_id,authorization_id,execution_id,operation_id
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
  producer_operation_id uuid NOT NULL,
  authenticated_receipt_tag text NOT NULL CHECK(authenticated_receipt_tag ~ '^[a-f0-9]{64}$'),
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

CREATE OR REPLACE FUNCTION validate_v1_intent_obligation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM mission_agent_v1_rollout_operations r
     WHERE r.workspace_id=NEW.workspace_id AND r.authorization_id=NEW.authorization_id
       AND r.execution_id=NEW.execution_id
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.operation IN (
    'stage_artifact','install_agent','install_launch_configuration','stop_agent','start_agent',
    'restore_previous_version'
  ) AND (
    NOT NEW.rollback_obligation OR NOT EXISTS (
      SELECT 1 FROM mission_agent_v1_rollback_obligations o
       WHERE o.workspace_id=NEW.workspace_id AND o.authorization_id=NEW.authorization_id
         AND o.execution_id=NEW.execution_id AND o.state<>'verified_closed'
    )
  ) THEN
    RAISE EXCEPTION 'v1 mutation intent requires exact durable rollback obligation';
  END IF;
  RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER mission_agent_v1_intent_rollback_guard
AFTER INSERT OR UPDATE ON mission_agent_replacement_mutation_intents
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION validate_v1_intent_obligation();

CREATE OR REPLACE FUNCTION validate_v1_current_fencing_epoch()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch bigint;
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
  SELECT max(epoch) INTO current_epoch
    FROM mission_agent_v1_fencing_epochs
   WHERE workspace_id=NEW.workspace_id AND authorization_id=NEW.authorization_id
     AND execution_id=NEW.execution_id AND fencing_namespace=NEW.fencing_namespace;
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
  IF current_epoch IS NULL OR current_epoch<>NEW.fencing_epoch
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
    IF rollout.state NOT IN ('recovery_only','human_intervention_required')
       OR obligation.state<>'executing'
       OR NEW.phase_sequence<>existing_phase_count+1
       OR expected_rollback_operation IS NULL
       OR NEW.operation<>expected_rollback_operation
       OR NOT (obligation.inverse_operations ? NEW.operation) THEN
      RAISE EXCEPTION 'v1 rollback mutation is outside inverse authority';
    END IF;
  ELSIF rollout.state<>'forward_active' OR rollout.forward_expires_at<=clock_timestamp()
     OR NEW.phase<>'forward' THEN
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
  IF NOT (
    (OLD.state='prepared' AND NEW.state IN ('drain_requested','expired_before_mutation')) OR
    (OLD.state='drain_requested' AND NEW.state IN ('drained_verified','expired_before_mutation')) OR
    (OLD.state='drained_verified' AND NEW.state IN ('forward_active','expired_before_mutation')) OR
    (OLD.state='forward_active' AND NEW.state IN ('observing','recovery_only','human_intervention_required')) OR
    (OLD.state='observing' AND NEW.state IN ('success_verified','recovery_only','human_intervention_required')) OR
    (OLD.state='recovery_only' AND NEW.state IN ('rollback_verified','human_intervention_required')) OR
    (OLD.state='human_intervention_required' AND NEW.state IN ('recovery_only','rollback_verified')) OR
    OLD.state=NEW.state
  ) THEN
    RAISE EXCEPTION 'invalid v1 rollout state transition';
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
GRANT EXECUTE ON FUNCTION close_mission_agent_v1_rollout(
  uuid,uuid,uuid,text,text,text,text,text
) TO mission_control_v1_verifier;
