-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 002 — sync_snapshots table
--
-- Stores the most recent outbound payload per (source_system, source_id) so
-- that the CRM→Marketo mapped-field-change gate (Task 16) can compute a delta
-- when the D365 webhook PreImage is not available (see ASSUMPTIONS §2).
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_snapshots (
  source_system  VARCHAR(32)  NOT NULL,
  source_id      VARCHAR(255) NOT NULL,
  source_type    VARCHAR(64)  NOT NULL,
  payload        JSONB        NOT NULL,
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_system, source_id)
);

CREATE INDEX IF NOT EXISTS idx_sync_snapshots_updated_at
  ON sync_snapshots (updated_at DESC);
