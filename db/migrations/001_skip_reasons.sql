-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 001 — Structured skip reasons
--
-- Adds two optional columns to sync_events so that skip outcomes from the
-- Marketo authority guard and lead-eligibility engine can be queried and
-- aggregated by category/criterion. The pre-existing `error_message` column
-- continues to carry the human-readable string (unchanged).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE sync_events
  ADD COLUMN IF NOT EXISTS reason_category  TEXT,
  ADD COLUMN IF NOT EXISTS reason_criterion TEXT;

CREATE INDEX IF NOT EXISTS idx_sync_events_reason_category
  ON sync_events (reason_category)
  WHERE reason_category IS NOT NULL;
