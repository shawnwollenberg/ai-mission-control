CREATE TABLE recommendation_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  recommendation_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  repository_id uuid NOT NULL,
  source_mission_id uuid NOT NULL,
  source_execution_id uuid NOT NULL,
  source_artifact_id uuid,
  title text NOT NULL,
  description text NOT NULL,
  reasoning text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_impact text NOT NULL CHECK (estimated_impact IN ('low','medium','high','critical')),
  estimated_risk text NOT NULL CHECK (estimated_risk IN ('low','medium','high')),
  estimated_effort text NOT NULL,
  suggested_validation jsonb NOT NULL DEFAULT '[]'::jsonb,
  acceptance_criteria jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('open','accepted','in_progress','completed','stale','dismissed')),
  linked_mission_id uuid,
  superseded_by uuid,
  status_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY (workspace_id,recommendation_id)
);

CREATE INDEX recommendation_repository_status_idx
  ON recommendation_projections(workspace_id,repository_id,status,created_at DESC);

CREATE INDEX recommendation_source_mission_idx
  ON recommendation_projections(workspace_id,source_mission_id,created_at);
