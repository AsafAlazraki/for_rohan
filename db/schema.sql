-- ─────────────────────────────────────────────────────────────────────────────
--  Supabase schema for dynamics-marketo-sync
--  Paste into Supabase → SQL editor → Run once.
-- ─────────────────────────────────────────────────────────────────────────────



-- ── sync_events ──────────────────────────────────────────────────────────────
-- Immutable audit log of every sync operation attempted by the engine.
CREATE TABLE IF NOT EXISTS sync_events (
    id              SERIAL PRIMARY KEY,

    source_system   VARCHAR(32) NOT NULL CHECK (source_system IN ('dynamics', 'marketo')),
    source_id       VARCHAR(255) NOT NULL,
    source_type     VARCHAR(64) NOT NULL,

    target_system   VARCHAR(32) NOT NULL CHECK (target_system IN ('dynamics', 'marketo')),
    target_id       VARCHAR(255),

    payload         JSONB       NOT NULL DEFAULT '{}',

    status          VARCHAR(32) NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','success','failed','skipped')),
    attempt_count   SMALLINT    NOT NULL DEFAULT 0,
    error_message   TEXT,
    error_detail    JSONB,

    reason_category  TEXT,
    reason_criterion TEXT,

    dedup_key       VARCHAR(64) UNIQUE,
    job_id          VARCHAR(128),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_events_status     ON sync_events (status);
CREATE INDEX IF NOT EXISTS idx_sync_events_source     ON sync_events (source_system, source_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_target     ON sync_events (target_system, target_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_created_at ON sync_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_events_dedup_key  ON sync_events (dedup_key);
CREATE INDEX IF NOT EXISTS idx_sync_events_reason_category
  ON sync_events (reason_category) WHERE reason_category IS NOT NULL;

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_events_updated_at ON sync_events;
CREATE TRIGGER trg_sync_events_updated_at
    BEFORE UPDATE ON sync_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── admin_config ─────────────────────────────────────────────────────────────
-- Runtime credential/config key-value store. Read through src/config/loader.js
-- with a 60-second in-process cache.
CREATE TABLE IF NOT EXISTS admin_config (
    key         TEXT        PRIMARY KEY,
    value       TEXT        NOT NULL,
    is_secret   BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_admin_config_updated_at ON admin_config;
CREATE TRIGGER trg_admin_config_updated_at
    BEFORE UPDATE ON admin_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── sync_snapshots ───────────────────────────────────────────────────────────
-- Most recent outbound payload per (source_system, source_id). Used by the
-- CRM→Marketo mapped-field-change gate to compute deltas when the D365
-- webhook PreImage is not available.
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

-- ── outbound_webhook_sinks / outbound_webhook_deliveries ─────────────────────
-- Outbound webhook sinks: admins register URLs the service POSTs to on every
-- sync_events insert that matches the sink's filters. HMAC-SHA256 signed.
-- Per-attempt outcomes logged in outbound_webhook_deliveries for debugging.
CREATE TABLE IF NOT EXISTS outbound_webhook_sinks (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  filter_status   TEXT[],
  filter_category TEXT[],
  filter_sources  TEXT[],
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery   TIMESTAMPTZ,
  last_status     INT
);
CREATE INDEX IF NOT EXISTS idx_outbound_webhook_sinks_enabled
  ON outbound_webhook_sinks (enabled) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id           SERIAL PRIMARY KEY,
  sink_id      INTEGER REFERENCES outbound_webhook_sinks(id) ON DELETE CASCADE,
  event_id     INTEGER REFERENCES sync_events(id) ON DELETE SET NULL,
  url          TEXT NOT NULL,
  status       INT,
  response_ms  INT,
  error        TEXT,
  attempt      INT NOT NULL DEFAULT 1,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_outbound_webhook_deliveries_sink_time
  ON outbound_webhook_deliveries (sink_id, delivered_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbound_webhook_deliveries_time
  ON outbound_webhook_deliveries (delivered_at DESC);

-- ── engagement_dedup ─────────────────────────────────────────────────────────
-- Per-activity decision log for the Marketo engagement-ingest pipeline (Doc 2).
-- Doubles as the dedup state for the per-type filter rules.
CREATE TABLE IF NOT EXISTS engagement_dedup (
  marketo_activity_id             BIGINT PRIMARY KEY,
  activity_type_id                INT NOT NULL,
  marketo_lead_id                 BIGINT,
  asset_name                      TEXT,
  url                             TEXT,
  dynamics_contact_id             TEXT,
  dynamics_engagement_activity_id TEXT,
  filter_decision                 TEXT NOT NULL CHECK (filter_decision IN ('written','skipped','unmatched')),
  filter_reason                   TEXT,
  occurred_at                     TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent rename for any pre-existing deployments that still carry the
-- legacy `dynamics_task_id` column (mirrors migration
-- db/migrations/004_rename_engagement_task_id.sql so a fresh `supabase.sql`
-- run against an existing DB ends up in the same shape).
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

CREATE INDEX IF NOT EXISTS engagement_dedup_created_at_idx ON engagement_dedup(created_at DESC);
CREATE INDEX IF NOT EXISTS engagement_dedup_lead_type_idx  ON engagement_dedup(marketo_lead_id, activity_type_id, created_at DESC);
