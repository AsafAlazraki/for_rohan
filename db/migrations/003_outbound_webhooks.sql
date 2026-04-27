-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 003 — Outbound webhook sinks
--
-- Enables this service to ACT AS a webhook source: admins register sink URLs
-- in `outbound_webhook_sinks`, and every sync_events insert that matches a
-- sink's filters is POSTed to the sink with an HMAC-SHA256 signature.
-- Per-attempt delivery outcomes are persisted in `outbound_webhook_deliveries`
-- for debugging from the Admin UI.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS outbound_webhook_sinks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  filter_status   TEXT[],   -- e.g. ['success','failed'], empty/NULL = all
  filter_category TEXT[],   -- e.g. ['authority'],        empty/NULL = all
  filter_sources  TEXT[],   -- e.g. ['dynamics','marketo'], empty/NULL = all
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_delivery   TIMESTAMPTZ,
  last_status     INT
);

CREATE INDEX IF NOT EXISTS idx_outbound_webhook_sinks_enabled
  ON outbound_webhook_sinks (enabled) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS outbound_webhook_deliveries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sink_id      UUID REFERENCES outbound_webhook_sinks(id) ON DELETE CASCADE,
  event_id     UUID REFERENCES sync_events(id) ON DELETE SET NULL,
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
