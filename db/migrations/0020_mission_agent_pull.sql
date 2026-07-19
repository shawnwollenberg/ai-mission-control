ALTER TABLE agents
  ADD COLUMN delivery_mode text NOT NULL DEFAULT 'push' CHECK (delivery_mode IN ('push','pull')),
  ADD COLUMN mission_agent_version text,
  ADD COLUMN mission_agent_adapter text,
  ADD COLUMN pull_ready_at timestamptz;

ALTER TABLE repositories
  ADD COLUMN location_mode text NOT NULL DEFAULT 'server' CHECK (location_mode IN ('server','mission_agent')),
  ADD COLUMN repository_fingerprint text,
  ADD COLUMN observed_remote_url text,
  ADD COLUMN observed_commit text;

CREATE UNIQUE INDEX repositories_agent_fingerprint_idx
  ON repositories(workspace_id,repository_fingerprint)
  WHERE repository_fingerprint IS NOT NULL AND disabled_at IS NULL;

CREATE TABLE pull_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  task_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('available','leased','acknowledged','released','completed')),
  payload jsonb NOT NULL,
  lease_owner text,
  lease_token_hash text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  last_renewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,assignment_id),
  UNIQUE (workspace_id,execution_id),
  FOREIGN KEY (workspace_id,execution_id) REFERENCES execution_projections(workspace_id,execution_id) ON DELETE CASCADE
);

CREATE INDEX pull_assignments_claim_idx
  ON pull_assignments(workspace_id,agent_id,status,created_at)
  WHERE status IN ('available','leased','acknowledged');
