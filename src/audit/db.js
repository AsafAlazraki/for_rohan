'use strict';

const fs = require('fs');
const { Pool } = require('pg');
const logger = require('./logger');

let _pool = null;
let _warnedNoCa = false;

function buildSslConfig() {
  // Explicit CA bundle — required in any environment with TLS interception
  // (corporate proxies, self-signed chains on PostgreSQL Pooler alt-endpoints,
  // etc). This is the preferred path — validation stays on, trust anchored
  // at the operator-supplied CA.
  if (process.env.PG_CA_CERT) {
    try {
      return { ca: fs.readFileSync(process.env.PG_CA_CERT) };
    } catch (err) {
      // Don't kill the process — a bad path in .env shouldn't prevent the
      // whole app from starting. Fall back to the system CA store with a
      // loud WARN so the operator sees it.
      logger.warn(
        `[audit/db] PG_CA_CERT is set to "${process.env.PG_CA_CERT}" but the file ` +
        `could not be read: ${err.message}. Falling back to the system CA store. ` +
        `Either correct the path (absolute paths are safest on Windows), or unset ` +
        `PG_CA_CERT to suppress this warning.`,
      );
      return true;
    }
  }

  // Fallback: system CA store. If the Postgres endpoint's certificate chain
  // is self-signed (corporate intercepting proxy, local pooler cert) the
  // connection will fail with SELF_SIGNED_CERT_IN_CHAIN. Emit a one-time
  // boot WARN so operators know they need PG_CA_CERT.
  if (!_warnedNoCa && process.env.DATABASE_URL) {
    _warnedNoCa = true;
    logger.warn(
      'PG_CA_CERT is not set. SSL verification will rely on the system CA store. ' +
      'If connecting through a corporate proxy or against a pooler with a self-signed chain, ' +
      'stats queries may fail with SELF_SIGNED_CERT_IN_CHAIN. ' +
      'Set PG_CA_CERT to the path of the CA bundle your IT team provides.',
    );
  }
  return true;
}

function getPool() {
  if (_pool) return _pool;

  // Keep the app pool small and release idle connections quickly to avoid exhausting connection limits.
  const max = parseInt(process.env.PG_POOL_MAX || '5', 10);
  const idleTimeoutMillis = parseInt(process.env.PG_POOL_IDLE_MS || '10000', 10);

  const connectionString = process.env.DATABASE_URL;
  if (connectionString) {
    _pool = new Pool({
      connectionString,
      ssl: buildSslConfig(),
      max,
      idleTimeoutMillis,
    });
  } else {
    _pool = new Pool({
      host:     process.env.PGHOST     || 'localhost',
      port:     parseInt(process.env.PGPORT || '5432', 10),
      database: process.env.PGDATABASE || 'sync_db',
      user:     process.env.PGUSER     || 'sync_user',
      password: process.env.PGPASSWORD,
      ssl:      process.env.PGSSL === 'true' ? buildSslConfig() : false,
      max,
      idleTimeoutMillis,
    });
  }
  return _pool;
}

/**
 * Persist a sync event to the audit log.
 *
 * @param {object} event
 * @returns {Promise<{ id: string }>}
 */
async function logEvent(event) {
  const {
    source_system,
    source_id,
    source_type      = 'contact',
    target_system,
    target_id        = null,
    payload          = {},
    status           = 'success',
    error_message    = null,
    error_detail     = null,
    reason_category  = null,
    reason_criterion = null,
    job_id           = null,
    dedup_key        = null,
  } = event;

  const { rows } = await getPool().query(
    `INSERT INTO sync_events
       (source_system, source_id, source_type,
        target_system, target_id,
        payload, status,
        error_message, error_detail,
        reason_category, reason_criterion,
        job_id, dedup_key, processed_at)
     VALUES ($1,$2,$3, $4,$5, $6,$7, $8,$9, $10,$11, $12,$13, NOW())
     RETURNING id`,
    [
      source_system,
      String(source_id || ''),
      source_type,
      target_system,
      target_id != null  ? String(target_id)  : null,
      JSON.stringify(payload),
      status,
      error_message,
      error_detail != null ? JSON.stringify(error_detail) : null,
      reason_category,
      reason_criterion,
      job_id    != null  ? String(job_id)    : null,
      dedup_key,
    ],
  );

  // Fire-and-forget: dispatch to registered outbound webhook sinks. We require
  // the module lazily to avoid a circular require (dispatcher imports getPool
  // from this module). `dispatchEvent` never throws.
  try {
     
    const { dispatchEvent } = require('../webhooks/outboundDispatcher');
    const dispatchPromise = dispatchEvent({
      id:               rows[0].id,
      source_system,
      source_id:        String(source_id || ''),
      source_type,
      target_system,
      target_id:        target_id != null ? String(target_id) : null,
      status,
      error_message,
      reason_category,
      reason_criterion,
      payload,
      created_at:       new Date(),
    });
    // Attach a catch so unhandled rejections never leak — we truly don't wait.
    if (dispatchPromise && typeof dispatchPromise.catch === 'function') {
      dispatchPromise.catch(() => {});
    }
  } catch {
    // Dispatcher load failures must never break the audit write.
  }

  return rows[0];
}

/**
 * Convenience wrapper for skip-outcome audit writes. Produces a `status:'skipped'`
 * row with structured `reason_category` / `reason_criterion` and a human-
 * readable `error_message` of the form `<category>:<reason>`.
 *
 * @param {{ job: { id: string },
 *           source: 'dynamics'|'marketo',
 *           target?: 'dynamics'|'marketo',
 *           sourceType?: string,
 *           sourceId?: string,
 *           payload?: object,
 *           reason: string,
 *           category: string,
 *           criterion?: string }} args
 * @returns {Promise<{ id: string }>}
 */
async function logSkip(args) {
  const {
    job,
    source,
    target     = source === 'dynamics' ? 'marketo' : 'dynamics',
    sourceType = 'contact',
    sourceId   = String(job?.id || ''),
    payload    = {},
    reason,
    category,
    criterion  = null,
  } = args;

  return logEvent({
    source_system:    source,
    source_id:        sourceId,
    source_type:      sourceType,
    target_system:    target,
    payload,
    status:           'skipped',
    error_message:    `${category}:${reason}`,
    reason_category:  category,
    reason_criterion: criterion,
    job_id:           job?.id != null ? String(job.id) : null,
  });
}

/**
 * Return per-status counts for sync events matching the given filters.
 *
 * @param {{ from?: Date, to?: Date, source_system?: string, status?: string }} filters
 * @returns {Promise<Array<{ status: string, count: string }>>}
 */
async function getSyncStats(filters = {}) {
  const { from, to, source_system, status } = filters;

  const conditions = [];
  const values     = [];
  let   idx        = 1;

  if (from)          { conditions.push(`created_at >= $${idx++}`);    values.push(from); }
  if (to)            { conditions.push(`created_at <= $${idx++}`);    values.push(to); }
  if (source_system) { conditions.push(`source_system = $${idx++}`);  values.push(source_system); }
  if (status)        { conditions.push(`status = $${idx++}`);         values.push(status); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await getPool().query(
    `SELECT status, COUNT(*) AS count FROM sync_events ${where} GROUP BY status`,
    values,
  );

  return rows;
}

/**
 * Upsert the latest outbound payload snapshot for a given source record.
 *
 * @param {{ source_system: 'dynamics'|'marketo',
 *           source_id:     string,
 *           source_type:   string,
 *           payload:       object }} snapshot
 * @returns {Promise<void>}
 */
async function upsertSnapshot(snapshot) {
  const { source_system, source_id, source_type, payload } = snapshot;
  if (!source_system || !source_id || !source_type) {
    throw new Error('[db.upsertSnapshot] source_system, source_id, source_type required');
  }

  await getPool().query(
    `INSERT INTO sync_snapshots (source_system, source_id, source_type, payload, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (source_system, source_id) DO UPDATE
       SET payload     = EXCLUDED.payload,
           source_type = EXCLUDED.source_type,
           updated_at  = NOW()`,
    [source_system, String(source_id), source_type, JSON.stringify(payload || {})],
  );
}

/**
 * Load the most recent snapshot for a source record, or null if none exists.
 *
 * @param {{ source_system: string, source_id: string }} key
 * @returns {Promise<{ payload: object, source_type: string, updated_at: Date } | null>}
 */
async function loadSnapshot({ source_system, source_id }) {
  const { rows } = await getPool().query(
    `SELECT source_type, payload, updated_at
       FROM sync_snapshots
      WHERE source_system = $1 AND source_id = $2`,
    [source_system, String(source_id)],
  );
  if (!rows.length) return null;
  const r = rows[0];
  return {
    source_type: r.source_type,
    payload:     typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload,
    updated_at:  r.updated_at,
  };
}

/** Test helper: inject a pre-built pool (e.g. a jest mock). */
function _setPool(pool) {
  _pool = pool;
}

module.exports = {
  logEvent, logSkip, getSyncStats,
  upsertSnapshot, loadSnapshot,
  getPool, _setPool,
};
