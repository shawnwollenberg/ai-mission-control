ALTER TABLE jobs
  ADD COLUMN priority integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_at timestamptz;

CREATE INDEX jobs_priority_claim_idx ON jobs (priority DESC, available_at, id)
  WHERE status IN ('pending', 'failed');
