'use strict';


const express = require('express');
const { bus } = require('../events/bus');
const { getPool } = require('../audit/db');
// Removed PostgreSQL client import


const router = express.Router();

/**
 * GET /api/events/stream
 *
 * Server-Sent Events stream. The worker/dlq emit on the in-process bus; this
 * route forwards every emission to every connected browser. Sends a periodic
 * keepalive comment so proxies don't close idle connections.
 */

router.get('/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-transform',
    Connection:          'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx response buffering
  });
  res.write(`: connected ${new Date().toISOString()}\n\n`);

  const onSync = (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (err) {
      console.error('[SSE] Write error:', err);
    }
  };
  bus.on('sync', onSync);

  // Lower keepalive interval to 10s to avoid proxy timeouts
  const keepalive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      console.error('[SSE] Keepalive write error:', err);
    }
  }, 10_000);

  req.on('close', () => {
    clearInterval(keepalive);
    bus.off('sync', onSync);
    console.log('[SSE] Client disconnected');
  });
});

/**
 * GET /api/events/stats
 *
 * Provides aggregated metrics for the Dashboard Overview page.
 */
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    const now = new Date();
    const ago24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const ago48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    // 1. Total events (success only)
    const totalRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'success'");
    const totalEvents = parseInt(totalRes.rows[0].count, 10);

    // 2. 24h delta (success only)
    const last24hRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'success' AND created_at >= $1", [ago24h]);
    const prev24hRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'success' AND created_at >= $1 AND created_at < $2", [ago48h, ago24h]);
    
    const count24h = parseInt(last24hRes.rows[0].count, 10);
    const countPrev24h = parseInt(prev24hRes.rows[0].count, 10);
    
    let percentChange = 0;
    if (countPrev24h > 0) {
      percentChange = ((count24h - countPrev24h) / countPrev24h) * 100;
    } else if (count24h > 0) {
      percentChange = 100;
    }

    // 3. Recent errors
    const recentErrorsRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'failed' AND created_at >= $1", [ago24h]);
    const recentErrors = parseInt(recentErrorsRes.rows[0].count, 10);

    const totalErrorsRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'failed'");
    const totalErrors = parseInt(totalErrorsRes.rows[0].count, 10);

    // 4. Sync Status
    const ago1h = new Date(now.getTime() - 60 * 60 * 1000);
    const ago10m = new Date(now.getTime() - 10 * 60 * 1000);
    
    const failures1hRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'failed' AND created_at >= $1", [ago1h]);
    const failures1h = parseInt(failures1hRes.rows[0].count, 10);
    
    const pending10mRes = await pool.query("SELECT COUNT(*) FROM sync_events WHERE status = 'pending' AND created_at < $1", [ago10m]);
    const pending10m = parseInt(pending10mRes.rows[0].count, 10);

    let syncStatus = 'Healthy';
    if (failures1h > 10 || pending10m > 100) {
      syncStatus = 'Unhealthy';
    } else if (failures1h > 0 || pending10m >= 50) {
      syncStatus = 'Degraded';
    }

    // 5. Webhook Success Rate (last 24h)
    const whRes = await pool.query(`
      SELECT 
        COUNT(*) as total, 
        COUNT(*) FILTER (WHERE status >= 200 AND status < 300) as success 
      FROM outbound_webhook_deliveries 
      WHERE delivered_at >= $1
    `, [ago24h]);
    
    let webhookSuccessRate = 0;
    const whTotal = parseInt(whRes.rows[0].total, 10);
    const whSuccess = parseInt(whRes.rows[0].success, 10);
    if (whTotal > 0) {
      webhookSuccessRate = (whSuccess / whTotal) * 100;
    } else {
      webhookSuccessRate = 100; // default if no deliveries
    }

    // 6. Graph Data — period is configurable via ?graphPeriod=24h|7d|30d
    const graphPeriod = req.query.graphPeriod || '24h';
    let graphSince, graphTrunc, graphIntervals;
    if (graphPeriod === '7d') {
      graphSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      graphTrunc = 'day';
      graphIntervals = 7;
    } else if (graphPeriod === '30d') {
      graphSince = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      graphTrunc = 'day';
      graphIntervals = 30;
    } else {
      graphSince = ago24h;
      graphTrunc = 'hour';
      graphIntervals = 24;
    }

    const hourlyRes = await pool.query(`
      SELECT date_trunc('${graphTrunc}', created_at) AS bucket, COUNT(*) AS count
      FROM sync_events
      WHERE created_at >= $1
      GROUP BY 1
      ORDER BY 1 ASC
    `, [graphSince]);

    const graphData = [];
    for (let i = graphIntervals - 1; i >= 0; i--) {
      let bDate;
      if (graphTrunc === 'hour') {
        bDate = new Date(now.getTime() - i * 60 * 60 * 1000);
        bDate.setUTCMinutes(0, 0, 0);
      } else {
        bDate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        bDate.setUTCHours(0, 0, 0, 0);
      }

      const found = hourlyRes.rows.find(r => {
        const rowDate = new Date(r.bucket);
        return rowDate.getTime() === bDate.getTime();
      });

      graphData.push({
        time: bDate.toISOString(),
        hourLabel: graphTrunc === 'hour'
          ? bDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : bDate.toLocaleDateString([], { month: 'short', day: 'numeric' }),
        count: found ? parseInt(found.count, 10) : 0
      });
    }

    res.json({
      totalEvents,
      count24h,
      percentChange: parseFloat(percentChange.toFixed(1)),
      totalErrors,
      recentErrors,
      syncStatus,
      webhookSuccessRate: parseFloat(webhookSuccessRate.toFixed(1)),
      graphData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/events/webhook-usage
 *
 * Provides aggregated usage metrics for the Webhooks dashboard page.
 * query.period: '24h', '7d', or '30d'
 */
router.get('/webhook-usage', async (req, res) => {
  try {
    const period = req.query.period || '24h';
    const now = new Date();
    let since;
    let trunc;
    let intervals;
    
    if (period === '7d') {
      since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      trunc = 'day';
      intervals = 7;
    } else if (period === '30d') {
      since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      trunc = 'day';
      intervals = 30;
    } else {
      // default 24h
      since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      trunc = 'hour';
      intervals = 24;
    }

    const pool = getPool();


    // 1. Per-entity totals (filtered) and last_received (unfiltered)
    // Get totals for the selected period
    const statsRes = await pool.query(`
      SELECT 
        source_system, 
        source_type, 
        COUNT(*) as total
      FROM sync_events 
      WHERE created_at >= $1 AND source_system IN ('dynamics', 'marketo') 
      GROUP BY 1, 2
    `, [since]);

    // Get last_received for all time
    const lastReceivedRes = await pool.query(`
      SELECT 
        source_system, 
        source_type, 
        MAX(created_at) as last_received
      FROM sync_events
      WHERE source_system IN ('dynamics', 'marketo')
      GROUP BY 1, 2
    `);

    // 2. Per-entity graph data
    const graphRes = await pool.query(`
      SELECT 
        date_trunc('${trunc}', created_at) AS time_bucket, 
        source_system, 
        source_type, 
        COUNT(*) as count
      FROM sync_events
      WHERE created_at >= $1 AND source_system IN ('dynamics', 'marketo')
      GROUP BY 1, 2, 3
      ORDER BY 1 ASC
    `, [since]);

    // 3. Final structured response
    const systems = { dynamics: [], marketo: [] };
    const allKeys = new Set();



    statsRes.rows.forEach(r => {
      const sys = r.source_system;
      const type = r.source_type || 'Unknown';
      const t = type.toLowerCase();

      // Only allow 'contact' and 'lead' types
      if (t !== 'contact' && t !== 'lead') return;

      // Improved descriptive naming
      let name;
      if (t === 'contact') name = 'Contact Created';
      else if (t === 'lead') name = 'Lead Created';

      const id = `${sys}_${type}`;
      allKeys.add(id);

      // Find the true last_received for this system/type
      const lastReceivedRow = lastReceivedRes.rows.find(lr => lr.source_system === sys && (lr.source_type || 'Unknown') === type);
      const last_received = lastReceivedRow ? lastReceivedRow.last_received : null;

      systems[sys].push({
        id,
        type,
        name,
        total: parseInt(r.total, 10),
        last_received,
        active: !!last_received
      });
    });

    // Ensure at least placeholders if nothing found
    if (systems.dynamics.length === 0) {
      // Find last_received for contact
      const lastReceivedRow = lastReceivedRes.rows.find(lr => lr.source_system === 'dynamics' && (lr.source_type || 'Unknown').toLowerCase() === 'contact');
      systems.dynamics.push({ id: 'dynamics_Contact', type: 'Contact', name: 'Contact Created', total: 0, last_received: lastReceivedRow ? lastReceivedRow.last_received : null, active: !!(lastReceivedRow && lastReceivedRow.last_received) });
      allKeys.add('dynamics_Contact');
    }
    if (systems.marketo.length === 0) {
      // Find last_received for lead
      const lastReceivedRow = lastReceivedRes.rows.find(lr => lr.source_system === 'marketo' && (lr.source_type || 'Unknown').toLowerCase() === 'lead');
      systems.marketo.push({ id: 'marketo_Lead', type: 'Lead', name: 'Lead Created', total: 0, last_received: lastReceivedRow ? lastReceivedRow.last_received : null, active: !!(lastReceivedRow && lastReceivedRow.last_received) });
      allKeys.add('marketo_Lead');
    }

    // 2. Per-entity graph data (Zero-filling)
    const graphData = [];
    for (let i = intervals - 1; i >= 0; i--) {
      let bDate;
      if (trunc === 'hour') {
        bDate = new Date(now.getTime() - i * 60 * 60 * 1000);
        bDate.setUTCMinutes(0, 0, 0);
      } else {
        bDate = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        bDate.setUTCHours(0, 0, 0, 0);
      }
      
      const timeStr = bDate.toISOString();
      const label = trunc === 'hour' 
        ? bDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        : bDate.toLocaleDateString([], { month: 'short', day: 'numeric' });

      // Pre-fill with 0 for all keys to ensure flat lines in Recharts
      const bucketData = { time: timeStr, label };
      allKeys.forEach(k => bucketData[k] = 0);
      
      // Add count for each system/type combo found in graphRes
      graphRes.rows.forEach(r => {
        const t = (r.source_type || 'Unknown').toLowerCase();
        if (t !== 'contact' && t !== 'lead') return;
        if (new Date(r.time_bucket).getTime() === bDate.getTime()) {
          const key = `${r.source_system}_${r.source_type || 'Unknown'}`;
          bucketData[key] = parseInt(r.count, 10);
        }
      });

      graphData.push(bucketData);
    }

    res.json({
      systems,
      graphData
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/events?page=1&limit=25
 *
 * Paginated history from the sync_events table in PostgreSQL.
 */


router.get('/', async (req, res) => {
  const page  = Math.max(1,  parseInt(req.query.page,  10) || 1);
  const limit = Math.max(1,  Math.min(100, parseInt(req.query.limit, 10) || 25));
  const status = String(req.query.status || '').trim().toLowerCase();
  const search = String(req.query.search || '').trim();
  // entityType filter: 'contact' | 'lead' | 'account' (matches sync_events.source_type).
  const entityType = String(req.query.entityType || '').trim().toLowerCase();
  const offset = (page - 1) * limit;
  try {
    const clauses = [];
    const params = [];

    // Hide dedupe skips (duplicate webhook events where no mapped field
    // changed) from the main feed — they're still in sync_events for
    // forensics and still surface in /api/events/skipped aggregates.
    clauses.push(`NOT (status = 'skipped' AND reason_category = 'no-change')`);

    if (status) {
      params.push(status);
      clauses.push(`LOWER(status) = $${params.length}`);
    }

    if (entityType) {
      params.push(entityType);
      clauses.push(`LOWER(source_type) = $${params.length}`);
    }

    if (search) {
      params.push(`%${search}%`);
      const i = params.length;
      clauses.push(`(
        source_id ILIKE $${i} OR
        target_id ILIKE $${i} OR
        source_system ILIKE $${i} OR
        target_system ILIKE $${i} OR
        error_message ILIKE $${i} OR
        payload::text ILIKE $${i}
      )`);
    }

    const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';

    const { rows } = await getPool().query(`
      SELECT id,source_system,target_system,source_id,source_type,target_id,status,error_message,payload,created_at
      FROM sync_events
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, [...params, limit, offset]);

    const countRes = await getPool().query(`SELECT COUNT(*) FROM sync_events ${where}`, params);
    const total = parseInt(countRes.rows[0].count, 10);
    const pages = Math.ceil(total / limit);

    res.json({ rows, total, page, limit, pages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/events/by-source?source=<dynamics|marketo>&sourceId=<id>&limit=<n>
 *
 * Returns the full audit trail for a single source record. Powers the
 * per-record drill-down drawer in SyncView so operators can see every sync
 * outcome (success / skipped / failed) that ever touched the same record.
 *
 * Default limit = 50, max = 500. `payload_preview` is the event's JSONB
 * payload serialized to a string and truncated to ~500 characters so the
 * drawer doesn't have to page megabytes of payload bodies for the list view.
 *
 * Response shape:
 *   { source, sourceId, total,
 *     events: [{ id, status, source_type, target_id,
 *                error_message, reason_category, reason_criterion,
 *                created_at, payload_preview }] }
 */
router.get('/by-source', async (req, res) => {
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT     = 500;
  const PREVIEW_CHARS = 500;

  const source   = String(req.query.source   || '').toLowerCase();
  const sourceId = String(req.query.sourceId || '').trim();

  if (source !== 'dynamics' && source !== 'marketo') {
    return res.status(400).json({ error: 'source must be "dynamics" or "marketo"' });
  }
  if (!sourceId) {
    return res.status(400).json({ error: 'sourceId is required' });
  }

  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, parseInt(req.query.limit, 10) || DEFAULT_LIMIT),
  );

  try {
    const { rows } = await getPool().query(
      `SELECT id,
              status,
              source_type,
              target_id,
              error_message,
              reason_category,
              reason_criterion,
              payload,
              created_at
         FROM sync_events
        WHERE source_system = $1
          AND source_id     = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [source, sourceId, limit],
    );

    const events = rows.map(r => {
      let payloadStr;
      try {
        payloadStr = typeof r.payload === 'string'
          ? r.payload
          : JSON.stringify(r.payload ?? {});
      } catch {
        payloadStr = '';
      }
      const truncated = payloadStr.length > PREVIEW_CHARS;
      const preview   = truncated
        ? payloadStr.slice(0, PREVIEW_CHARS) + '…'
        : payloadStr;

      return {
        id:               r.id,
        status:           r.status,
        source_type:      r.source_type,
        target_id:        r.target_id,
        error_message:    r.error_message,
        reason_category:  r.reason_category,
        reason_criterion: r.reason_criterion,
        created_at:       r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        payload_preview:  preview,
        payload_truncated: truncated,
      };
    });

    res.json({
      source,
      sourceId,
      total:  events.length,
      events,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/events/skipped?since=<iso>&limit=<n>
 *
 * Returns `sync_events` rows where `status='skipped'`, grouped + counted by
 * `(reason_category, reason_criterion)`. Powers the Dashboard "Skipped events"
 * panel (see Task 18). Default `since` = 24h ago. Default `limit` = 50 groups.
 *
 * Response shape:
 *   { since: ISO, total: <n>, groups: [{ category, criterion, count, lastSeen }] }
 */
router.get('/skipped', async (req, res) => {
  const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_LIMIT     = 50;
  const MAX_LIMIT         = 500;

  const now      = new Date();
  const sinceRaw = req.query.since;
  const sinceDt  = sinceRaw ? new Date(sinceRaw) : new Date(now.getTime() - DEFAULT_WINDOW_MS);
  if (Number.isNaN(sinceDt.getTime())) {
    return res.status(400).json({ error: 'invalid since parameter' });
  }

  const limit = Math.max(
    1,
    Math.min(MAX_LIMIT, parseInt(req.query.limit, 10) || DEFAULT_LIMIT),
  );

  try {
    const { rows } = await getPool().query(
      `SELECT reason_category AS category,
              reason_criterion AS criterion,
              COUNT(*)::int     AS count,
              MAX(created_at)   AS last_seen
         FROM sync_events
        WHERE status = 'skipped'
          AND created_at >= $1
        GROUP BY reason_category, reason_criterion
        ORDER BY count DESC, last_seen DESC
        LIMIT $2`,
      [sinceDt.toISOString(), limit],
    );

    const groups = rows.map(r => ({
      category:  r.category,
      criterion: r.criterion,
      count:     Number(r.count),
      lastSeen:  r.last_seen instanceof Date ? r.last_seen.toISOString() : r.last_seen,
    }));
    const total = groups.reduce((acc, g) => acc + g.count, 0);

    res.json({
      since: sinceDt.toISOString(),
      total,
      groups,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
