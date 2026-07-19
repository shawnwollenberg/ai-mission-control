CREATE TABLE workspace_emergency_controls (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  aggregate_version integer NOT NULL DEFAULT 0,
  pause_new_executions boolean NOT NULL DEFAULT false,
  pause_remote_assignments boolean NOT NULL DEFAULT false,
  pause_codex_assignments boolean NOT NULL DEFAULT false,
  disable_all_schedules boolean NOT NULL DEFAULT false,
  stop_git_publication boolean NOT NULL DEFAULT false,
  updated_by text,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_event_position bigint NOT NULL DEFAULT 0
);
