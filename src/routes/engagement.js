'use strict';

/**
 * HTTP surface for the Marketo-engagement-ingest pipeline (Doc 2).
 *
 *   GET  /api/engagement/recent   — paginated dedup-table view
 *   GET  /api/engagement/stats    — totals + last-run summary
 *   POST /api/engagement/trigger  — manual "Run now" → runner.runOnce()
 *   POST /api/engagement/dry-run  — preview cycle (SIM mode, no writes)
 */

const express = require('express');
const logger  = require('../audit/logger');
const { getConfig } = require('../config/loader');
const { TYPE_LABELS } = require('../engagement/activityWriter');
const dedupDb = require('../engagement/dedupDb');
const runner  = require('../engagement/runner');

const router = express.Router();

// Map decision → frontend status. The doc spec uses
// 'written' | 'skipped' | 'unmatched' for the rows.
function statusFor(decision) {
  return decision; // already in the right shape
}

/**
 * GET /api/engagement/recent?limit=50&type=<id>&since=<iso>
 */
router.get('/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const type  = req.query.type ? parseInt(req.query.type, 10) : null;
    const since = req.query.since || null;
    if (req.query.type && Number.isNaN(type)) {
      return res.status(400).json({ error: 'type must be a numeric activity-type id' });
    }
    const rows = await dedupDb.listRecent({ limit, type, since });
    const shaped = rows.map(r => ({
      id:                 String(r.marketo_activity_id),
      marketoActivityId:  String(r.marketo_activity_id),
      type:               r.activity_type_id,
      typeName:           TYPE_LABELS[r.activity_type_id] || `Type ${r.activity_type_id}`,
      contactEmail:       null, // we don't persist email per-row; UI can join via Dynamics if needed
      dynamicsContactId:  r.dynamics_contact_id,
      dynamicsActivityId: r.dynamics_engagement_activity_id,
      assetName:          r.asset_name,
      occurredAt:         r.occurred_at,
      status:             statusFor(r.filter_decision),
      reason:             r.filter_reason,
    }));
    res.json({ rows: shaped });
  } catch (err) {
    logger.error({ err: err.message }, '[routes/engagement] /recent failed');
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/engagement/stats
 */
router.get('/stats', async (_req, res) => {
  try {
    const { total, byType, byStatus } = await dedupDb.aggregateStats();
    const byTypeOut   = {};
    for (const row of byType) {
      const label = TYPE_LABELS[row.type] || `Type ${row.type}`;
      byTypeOut[label] = row.n;
    }
    const byStatusOut = { written: 0, skipped: 0, unmatched: 0 };
    for (const row of byStatus) {
      if (row.status in byStatusOut) byStatusOut[row.status] = row.n;
    }

    let lastRun = null;
    const blob = await getConfig(runner.KEY_LAST_RUN);
    if (blob) {
      try { lastRun = JSON.parse(blob); }
      catch { lastRun = { raw: blob }; }
    }

    res.json({
      totalIngested: total,
      byType:        byTypeOut,
      byStatus:      byStatusOut,
      lastRun,
    });
  } catch (err) {
    logger.error({ err: err.message }, '[routes/engagement] /stats failed');
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/engagement/trigger
 * Manual "Run now". Returns the summary the runner produced.
 */
router.post('/trigger', async (_req, res) => {
  try {
    const summary = await runner.runOnce();
    res.json({ ok: true, summary });
  } catch (err) {
    logger.error({ err: err.message }, '[routes/engagement] /trigger failed');
    res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/engagement/dry-run
 * SIM-mode "Run now": Marketo reads happen for real, but no Dynamics writes,
 * no cursor advance and no 'written' rows added to engagement_dedup. The
 * response includes a `samples` array of up to 20 activities that WOULD have
 * been written, so the UI can render a credible preview.
 */
router.post('/dry-run', async (_req, res) => {
  try {
    const summary = await runner.runOnce({ dryRun: true });
    // Spec asks for `written: 0` — the runner already guarantees this in
    // dry-run mode, but we pin it explicitly to make the contract obvious.
    summary.written = 0;
    res.json({
      ok: true,
      dryRun: true,
      summary: {
        fetched:    summary.fetched,
        written:    0,
        skipped:    summary.skipped,
        unmatched:  summary.unmatched,
        durationMs: summary.durationMs,
        samples:    Array.isArray(summary.samples) ? summary.samples : [],
      },
    });
  } catch (err) {
    logger.error({ err: err.message }, '[routes/engagement] /dry-run failed');
    res.status(502).json({ ok: false, dryRun: true, error: err.message });
  }
});

module.exports = { router };
