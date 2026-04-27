'use strict';

const { QUEUE_NAME } = require('../queue/queue');
const { getPool }    = require('../audit/db');

/**
 * Per-state counts from the pgboss.job table.
 *
 * Queries SQL directly (not the pg-boss JS API) because v9's getQueueSize
 * doesn't accept a state filter. The schema is stable across v9 patch
 * releases.
 */
async function getQueueCountsByState(states) {
  // pg-boss v10+ defines `state` as the pgboss.job_state enum, which Postgres
  // won't implicitly coerce from text — cast both sides to text.
  const { rows } = await getPool().query(
    `SELECT state::text AS state, COUNT(*)::int AS c
       FROM pgboss.job
      WHERE name = $1
        AND state::text = ANY($2::text[])
      GROUP BY state`,
    [QUEUE_NAME, states],
  );
  return Object.fromEntries(rows.map(r => [r.state, r.c]));
}

/**
 * Pending + active counts from pg-boss.
 * @returns {Promise<{ waiting: number, active: number, delayed: number, total: number }>}
 */
async function getQueueDepth() {
  const counts  = await getQueueCountsByState(['created', 'retry', 'active']);
  const waiting = counts.created || 0;
  const delayed = counts.retry   || 0;
  const active  = counts.active  || 0;
  return { waiting, active, delayed, total: waiting + active + delayed };
}

/**
 * Number of permanently failed jobs (exhausted retries).
 * @returns {Promise<number>}
 */
async function getDLQDepth() {
  const counts = await getQueueCountsByState(['failed']);
  return counts.failed || 0;
}

/**
 * Fraction of sync events that failed within the last `windowMinutes` minutes.
 *
 * @param {number} [windowMinutes=15]
 * @returns {Promise<{ failedCount: number, totalCount: number, errorRate: number }>}
 */
async function getErrorRate(windowMinutes = 15) {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  const { rows } = await getPool().query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
       COUNT(*)                                  AS total_count
     FROM sync_events
     WHERE created_at >= $1`,
    [since],
  );

  const totalCount  = parseInt(rows[0].total_count,  10);
  const failedCount = parseInt(rows[0].failed_count, 10);

  return {
    failedCount,
    totalCount,
    errorRate: totalCount > 0 ? failedCount / totalCount : 0,
  };
}

/**
 * Aggregate snapshot of all metrics.
 * @returns {Promise<object>}
 */
async function getMetrics() {
  const [queueDepth, dlqDepth, errorRate] = await Promise.all([
    getQueueDepth(),
    getDLQDepth(),
    getErrorRate(15),
  ]);
  return { queueDepth, dlqDepth, errorRate, ts: new Date().toISOString() };
}

module.exports = { getQueueDepth, getDLQDepth, getErrorRate, getMetrics };
