CREATE TABLE mission_agent_replacement_bootstraps (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL,
  approval_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  protocol_version text NOT NULL CHECK(protocol_version = 'operator-replacement-bootstrap-v1'),
  authorization_record jsonb NOT NULL,
  authorization_checksum text NOT NULL CHECK(authorization_checksum ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK(state IN (
    'prepared','approved','draining','verified','staged','replacing','starting',
    'connected','accepted','completed','failed','rolling_back','rolled_back',
    'revoked','expired'
  )),
  aggregate_version integer NOT NULL CHECK(aggregate_version > 0),
  execution_count integer NOT NULL DEFAULT 0 CHECK(execution_count BETWEEN 0 AND 1),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  last_occurred_at timestamptz,
  last_event_checksum text CHECK(last_event_checksum IS NULL OR last_event_checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id),
  FOREIGN KEY(workspace_id,agent_id) REFERENCES agents(workspace_id,agent_id) ON DELETE RESTRICT,
  FOREIGN KEY(workspace_id,approval_id) REFERENCES approval_projections(workspace_id,approval_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX mission_agent_replacement_active_agent_idx
  ON mission_agent_replacement_bootstraps(workspace_id,agent_id)
  WHERE state IN ('prepared','approved','draining','verified','staged','replacing','starting','connected','accepted');

CREATE TABLE mission_agent_replacement_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL,
  event_id uuid NOT NULL,
  from_state text NOT NULL,
  to_state text NOT NULL,
  aggregate_version integer NOT NULL CHECK(aggregate_version > 1),
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  previous_event_checksum text CHECK(previous_event_checksum IS NULL OR previous_event_checksum ~ '^[a-f0-9]{64}$'),
  event_checksum text NOT NULL CHECK(event_checksum ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz NOT NULL,
  operator_identity text NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id,event_id),
  UNIQUE(workspace_id,authorization_id,aggregate_version),
  UNIQUE(workspace_id,authorization_id,event_checksum),
  FOREIGN KEY(workspace_id,authorization_id)
    REFERENCES mission_agent_replacement_bootstraps(workspace_id,authorization_id) ON DELETE CASCADE
);

CREATE TABLE mission_agent_replacement_credentials (
  workspace_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider_identifier text NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  scope_checksum text NOT NULL CHECK(scope_checksum ~ '^[a-f0-9]{64}$'),
  allowed_operations jsonb NOT NULL,
  verifier_fingerprint text NOT NULL CHECK(verifier_fingerprint ~ '^[a-f0-9]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  maximum_receipt_sequence integer NOT NULL CHECK(maximum_receipt_sequence > 0),
  revoked_at timestamptz,
  consumed_at timestamptz,
  PRIMARY KEY(workspace_id,credential_id),
  UNIQUE(workspace_id,authorization_id,execution_id),
  FOREIGN KEY(workspace_id,authorization_id)
    REFERENCES mission_agent_replacement_bootstraps(workspace_id,authorization_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,credential_id)
    REFERENCES agent_credentials(workspace_id,credential_id) ON DELETE RESTRICT
);

CREATE TABLE mission_agent_replacement_execution_claims (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  operator_identity text NOT NULL,
  provider_identifier text NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  generation integer NOT NULL CHECK(generation = 1),
  state text NOT NULL,
  last_accepted_sequence integer NOT NULL DEFAULT 0 CHECK(last_accepted_sequence >= 0),
  claimed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY(workspace_id,authorization_id,execution_id),
  UNIQUE(workspace_id,authorization_id),
  UNIQUE(workspace_id,credential_id),
  FOREIGN KEY(workspace_id,authorization_id)
    REFERENCES mission_agent_replacement_bootstraps(workspace_id,authorization_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,credential_id)
    REFERENCES mission_agent_replacement_credentials(workspace_id,credential_id) ON DELETE RESTRICT
);

CREATE TABLE mission_agent_replacement_mutation_intents (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  claim_generation integer NOT NULL CHECK(claim_generation = 1),
  sequence integer NOT NULL CHECK(sequence > 0),
  operation text NOT NULL,
  fixed_arguments_checksum text NOT NULL CHECK(fixed_arguments_checksum ~ '^[a-f0-9]{64}$'),
  expected_precondition_checksum text NOT NULL CHECK(expected_precondition_checksum ~ '^[a-f0-9]{64}$'),
  expected_postcondition_checksum text NOT NULL CHECK(expected_postcondition_checksum ~ '^[a-f0-9]{64}$'),
  from_state text NOT NULL,
  to_state text NOT NULL,
  retry_policy text NOT NULL CHECK(retry_policy IN ('inspect-then-once','never')),
  rollback_obligation boolean NOT NULL,
  intent_checksum text NOT NULL CHECK(intent_checksum ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN ('prepared','completed','abandoned')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  result_checksum text CHECK(result_checksum IS NULL OR result_checksum ~ '^[a-f0-9]{64}$'),
  host_journal_checksum text CHECK(host_journal_checksum IS NULL OR host_journal_checksum ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(workspace_id,authorization_id,execution_id,operation_id),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_replacement_execution_claims(workspace_id,authorization_id,execution_id)
      ON DELETE CASCADE
);

CREATE TABLE mission_agent_replacement_receipts (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  provider_identifier text NOT NULL,
  authorization_fingerprint text NOT NULL CHECK(authorization_fingerprint ~ '^[a-f0-9]{64}$'),
  claim_generation integer NOT NULL CHECK(claim_generation = 1),
  sequence integer NOT NULL CHECK(sequence > 0),
  request_nonce text NOT NULL,
  receipt_nonce text NOT NULL,
  operation text NOT NULL,
  operation_checksum text NOT NULL CHECK(operation_checksum ~ '^[a-f0-9]{64}$'),
  result_checksum text NOT NULL CHECK(result_checksum ~ '^[a-f0-9]{64}$'),
  host_journal_checksum text NOT NULL CHECK(host_journal_checksum ~ '^[a-f0-9]{64}$'),
  authentication_tag text NOT NULL CHECK(authentication_tag ~ '^[a-f0-9]{64}$'),
  received_at timestamptz NOT NULL,
  acknowledgement jsonb NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id,execution_id,operation_id),
  UNIQUE(workspace_id,authorization_id,execution_id,sequence),
  UNIQUE(workspace_id,credential_id,request_nonce),
  UNIQUE(workspace_id,credential_id,receipt_nonce),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_replacement_execution_claims(workspace_id,authorization_id,execution_id)
      ON DELETE CASCADE
);

CREATE TABLE mission_agent_replacement_evidence (
  workspace_id uuid NOT NULL,
  authorization_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  evidence_type text NOT NULL CHECK(evidence_type IN (
    'drain','process','heartbeat-capability','projection','smoke','rollback-equivalence'
  )),
  evidence_checksum text NOT NULL CHECK(evidence_checksum ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,authorization_id,execution_id,evidence_type,evidence_checksum),
  FOREIGN KEY(workspace_id,authorization_id,execution_id)
    REFERENCES mission_agent_replacement_execution_claims(workspace_id,authorization_id,execution_id)
      ON DELETE CASCADE
);
