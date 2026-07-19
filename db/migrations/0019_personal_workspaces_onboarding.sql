ALTER TABLE workspaces
  ADD COLUMN onboarding_completed_at timestamptz,
  ADD COLUMN onboarding_agent_type text CHECK (onboarding_agent_type IN ('codex','hermes','claude_code','generic_remote'));

CREATE INDEX workspaces_onboarding_incomplete_idx
  ON workspaces (created_at)
  WHERE onboarding_completed_at IS NULL;
