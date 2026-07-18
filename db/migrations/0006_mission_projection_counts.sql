ALTER TABLE mission_projections
  ADD COLUMN total_task_count integer NOT NULL DEFAULT 0 CHECK (total_task_count >= 0),
  ADD COLUMN completed_task_count integer NOT NULL DEFAULT 0 CHECK (completed_task_count >= 0),
  ADD COLUMN last_event_position bigint NOT NULL DEFAULT 0 CHECK (last_event_position >= 0),
  ADD CONSTRAINT mission_projection_task_count_check CHECK (completed_task_count <= total_task_count);

