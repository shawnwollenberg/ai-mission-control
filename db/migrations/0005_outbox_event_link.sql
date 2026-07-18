ALTER TABLE outbox
  ADD COLUMN event_id uuid REFERENCES events(event_id) ON DELETE CASCADE,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN completed_at timestamptz;

CREATE INDEX outbox_workspace_status_idx ON outbox (workspace_id, status, available_at, id);

