ALTER TABLE execution_projections
  ADD COLUMN base_branch text,
  ADD COLUMN base_commit text;

CREATE TABLE publication_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL,
  action_request_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  mission_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  repository_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('available','claimed','pushed','completed','failed')),
  payload jsonb NOT NULL,
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,assignment_id),
  UNIQUE (workspace_id,action_request_id)
);

CREATE INDEX publication_assignments_claim_idx
  ON publication_assignments(workspace_id,agent_id,status,created_at)
  WHERE status IN ('available','claimed');

UPDATE repositories
SET push_allowed=true,
    pull_request_allowed=true,
    provider_type='github',
    allowed_branch_prefixes='["mission/"]'::jsonb,
    allowed_remotes='["origin"]'::jsonb
WHERE location_mode='mission_agent'
  AND observed_remote_url ~* '(github\.com[:/])';
