-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 004 — Rename engagement_dedup.dynamics_task_id
--
-- The engagement-ingest pipeline now writes activities to the custom
-- activity-enabled entity `ubt_marketingengagementactivity` instead of the
-- OOTB `task` entity (spec #3 "Marketo API for Campaign Engagement Data"
-- §5.1). The column that caches the Dataverse record id follows suit:
--
--   dynamics_task_id → dynamics_engagement_activity_id
--
-- Idempotent: the rename only fires when the old column is present AND the
-- new one is not, so re-running is safe and fresh deployments (which get
-- the correct column name directly from db/supabase.sql) are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'engagement_dedup'
       AND column_name = 'dynamics_task_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'engagement_dedup'
       AND column_name = 'dynamics_engagement_activity_id'
  ) THEN
    ALTER TABLE engagement_dedup
      RENAME COLUMN dynamics_task_id TO dynamics_engagement_activity_id;
  END IF;
END $$;
