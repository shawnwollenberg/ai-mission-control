UPDATE schedule_run_projections SET actual_created_at=created_at WHERE status='created' AND actual_created_at IS NULL;
UPDATE notification_projections SET category='schedules' WHERE category='schedule_run';
