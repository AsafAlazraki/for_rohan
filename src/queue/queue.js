'use strict';

const PgBoss = require('pg-boss');

const QUEUE_NAME = process.env.SYNC_QUEUE_NAME || 'sync-events';

// Single pg-boss instance per process. pg-boss creates its own `pgboss` schema
// in the target database on first start(); no manual DDL required.
let _boss = null;
let _ready = null; // Promise<void> — resolves once the schema is applied and the queue exists

function getBoss() {
  if (_boss) return _boss;

  const connectionString =
    process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      '[queue] DATABASE_URL is required. ' +
      'Point it at your Azure PostgreSQL connection string.',
    );
  }

  // Azure PostgreSQL requires SSL; pg-boss forwards these options to pg.
  _boss = new PgBoss({
    connectionString,
    ssl: { rejectUnauthorized: false },
    // Cap pg-boss's internal pool to avoid exhausting connection limits.
    max: parseInt(process.env.PGBOSS_POOL_MAX || '5', 10),
    // Keep the housekeeping footprint small for a POC:
    retentionDays: 30, // how long completed jobs live in pgboss.archive
    archiveCompletedAfterSeconds: 60 * 60, // 1h
    monitorStateIntervalSeconds: 10,
  });
  return _boss;
}

/**
 * Start pg-boss and ensure the sync queue exists.
 * Safe to call multiple times — internally idempotent.
 */
async function startBoss() {
  if (_ready) return _ready;
  const boss = getBoss();

  _ready = (async () => {
    boss.on('error', (err) => {

      console.error('[queue] pg-boss error:', err.message);
    });
    await boss.start();
    // pg-boss v9 lazily creates queues on first publish — no createQueue call.
  })();

  return _ready;
}

/** Gracefully stop pg-boss (drains in-flight jobs). */
async function stopBoss() {
  if (_boss) {
    try { await _boss.stop({ graceful: true, close: true }); } catch { /* ignore */ }
    _boss = null;
    _ready = null;
  }
}

/**
 * Enqueue a sync job.
 * @param {string} _queueName  Ignored; retained for API compat with old producer.js
 * @param {object} data
 * @returns {Promise<string>}  pg-boss job id (uuid)
 */
async function enqueue(_queueName, data) {
  await startBoss();

  // Safety check: ensure the queue name is a string. If it's an object (like the corruption we saw),
  // force it to the correct value and log the anomaly.
  let targetQueue = QUEUE_NAME;
  if (typeof targetQueue !== 'string') {
    console.warn('[queue] CRITICAL: QUEUE_NAME is not a string! Current value:', targetQueue);
    targetQueue = 'sync-events';
  }

  console.log('[queue] Publishing to:', targetQueue);
  const jobId = await getBoss().send(targetQueue, data, {
    retryLimit: parseInt(process.env.SYNC_JOB_ATTEMPTS || '3', 10),
    retryDelay: 1,      // seconds; grows exponentially with retryBackoff
    retryBackoff: true,   // 1s -> 2s -> 4s
    expireInHours: 24,
  });
  return jobId;
}

/** Test helper: drop singletons between tests. */
function _reset() {
  _boss = null;
  _ready = null;
}

module.exports = { getBoss, startBoss, stopBoss, enqueue, QUEUE_NAME, _reset };
