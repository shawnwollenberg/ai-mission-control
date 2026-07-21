CREATE TABLE repository_health_assessments (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  assessment_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  repository_id uuid NOT NULL,
  source_mission_id uuid NOT NULL,
  source_execution_id uuid NOT NULL,
  source_artifact_id uuid NOT NULL,
  repository_commit text,
  score integer CHECK (score BETWEEN 0 AND 100),
  confidence integer NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  scoring_version text NOT NULL,
  dimensions jsonb NOT NULL,
  observations jsonb NOT NULL,
  assessed_at timestamptz NOT NULL,
  last_event_position bigint NOT NULL,
  PRIMARY KEY(workspace_id,assessment_id),
  FOREIGN KEY(workspace_id,repository_id) REFERENCES repositories(workspace_id,repository_id)
);

CREATE INDEX repository_health_history_idx
  ON repository_health_assessments(workspace_id,repository_id,assessed_at DESC);
