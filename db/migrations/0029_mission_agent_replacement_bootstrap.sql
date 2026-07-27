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
