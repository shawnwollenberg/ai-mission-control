ALTER TABLE agents
  ADD COLUMN remote_project_brain_capabilities jsonb,
  ADD COLUMN remote_project_brain_capabilities_at timestamptz;

ALTER TABLE project_brain_operation_projections
  DROP CONSTRAINT project_brain_operation_projections_status_check,
  ADD CONSTRAINT project_brain_operation_projections_status_check
  CHECK(status IN(
    'requested','authorized','denied','dispatched','accepted','started','succeeded','failed','cancelled'
  ));

CREATE TABLE remote_project_brain_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  mission_id uuid,
  execution_id uuid,
  agent_id uuid NOT NULL,
  attempt integer NOT NULL CHECK(attempt > 0),
  status text NOT NULL CHECK(status IN(
    'available','leased','acknowledged','running','succeeded','failed','released'
  )),
  request jsonb NOT NULL,
  request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
  response jsonb,
  recovery_event_emitted boolean NOT NULL DEFAULT true,
  accepted_event_emitted boolean NOT NULL DEFAULT false,
  started_event_emitted boolean NOT NULL DEFAULT false,
  lease_owner text,
  lease_token_hash text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  last_renewed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,assignment_id),
  UNIQUE(workspace_id,operation_id)
);
CREATE INDEX remote_project_brain_assignment_claim_idx
  ON remote_project_brain_assignments(workspace_id,agent_id,status,created_at)
  WHERE status IN('available','leased','acknowledged','running');

CREATE TABLE remote_project_brain_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  request_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request_checksum text NOT NULL CHECK(request_checksum ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK(status IN('accepted','running','succeeded','failed')),
  response_checksum text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,agent_id,request_id),
  UNIQUE(workspace_id,agent_id,idempotency_key)
);

CREATE TABLE remote_project_brain_artifacts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  mission_id uuid,
  execution_id uuid,
  kind text NOT NULL,
  repository_path text NOT NULL,
  schema_version text NOT NULL,
  repository_sha text NOT NULL,
  byte_size bigint NOT NULL CHECK(byte_size >= 0),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,artifact_id),
  UNIQUE(workspace_id,operation_id,kind,repository_path)
);

CREATE TABLE remote_project_brain_execution_dispatches (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  attempt integer NOT NULL,
  task_envelope jsonb NOT NULL,
  status text NOT NULL CHECK(status IN('awaiting_context','dispatched','invalidated')),
  context_artifact_id uuid,
  context_checksum text,
  starting_sha text,
  dispatched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,execution_id)
);
