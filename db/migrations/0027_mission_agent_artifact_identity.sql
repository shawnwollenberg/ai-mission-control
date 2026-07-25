ALTER TABLE agents
  ADD COLUMN mission_agent_artifact_checksum text,
  ADD COLUMN mission_agent_expected_checksum text,
  ADD COLUMN mission_agent_checksum_status text NOT NULL DEFAULT 'missing'
    CHECK(mission_agent_checksum_status IN('verified','missing','malformed','unapproved_version','mismatch')),
  ADD COLUMN mission_agent_manifest_version text,
  ADD COLUMN mission_agent_project_brain_compatible boolean NOT NULL DEFAULT false,
  ADD COLUMN mission_agent_checksum_rejection_reason text,
  ADD COLUMN mission_agent_artifact_verified_at timestamptz,
  ADD COLUMN mission_agent_capability_expires_at timestamptz;

CREATE TABLE mission_agent_capability_projections (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  advertised_version text NOT NULL,
  advertised_checksum text,
  expected_checksum text,
  manifest_version text,
  checksum_status text NOT NULL,
  project_brain_compatible boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  freshness_expires_at timestamptz NOT NULL,
  last_rejection_reason text,
  last_verified_at timestamptz,
  PRIMARY KEY(workspace_id,agent_id)
);

CREATE VIEW mission_agent_capability_status AS
SELECT p.*,
  (p.project_brain_compatible AND p.freshness_expires_at > now()) AS project_brain_eligible,
  (p.freshness_expires_at > now()) AS capability_fresh
FROM mission_agent_capability_projections p;
