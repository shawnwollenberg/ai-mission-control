UPDATE schedule_projections s SET
  total_created = stats.created,
  total_skipped = stats.skipped,
  total_queued = stats.queued,
  consecutive_skips = stats.trailing_skips
FROM (
  SELECT s0.workspace_id,s0.schedule_id,
    count(r.*) FILTER(WHERE r.status='created')::int created,
    count(r.*) FILTER(WHERE r.status='skipped')::int skipped,
    count(r.*) FILTER(WHERE r.status='queued')::int queued,
    count(r.*) FILTER(WHERE r.status='skipped' AND r.intended_run_at>COALESCE((SELECT max(r2.intended_run_at) FROM schedule_run_projections r2 WHERE r2.workspace_id=s0.workspace_id AND r2.schedule_id=s0.schedule_id AND r2.status<>'skipped'),'-infinity'))::int trailing_skips
  FROM schedule_projections s0 LEFT JOIN schedule_run_projections r ON r.workspace_id=s0.workspace_id AND r.schedule_id=s0.schedule_id
  GROUP BY s0.workspace_id,s0.schedule_id
) stats WHERE s.workspace_id=stats.workspace_id AND s.schedule_id=stats.schedule_id;
