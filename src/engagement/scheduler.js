'use strict';

/**
 * Wires the engagement-ingest pipeline into pg-boss as a scheduled job.
 *
 * Honours these admin_config keys:
 *   MARKETO_INGEST_ENABLED        — 'true'|'false' (default 'true')
 *   MARKETO_INGEST_INTERVAL_MIN   — int minutes (default 15)
 *
 * Idempotent: a second call simply re-syncs the cron expression / handler.
 */

const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');
const { getBoss, startBoss } = require('../queue/queue');
const runner = require('./runner');

const QUEUE_NAME = 'marketo-engagement-ingest';

let _started = false;

function isEnabled(val) {
  if (val == null || val === '') return true;       // default ON
  return String(val).toLowerCase() !== 'false';
}

function intervalMinutes(val) {
  const n = parseInt(val, 10);
  return (isNaN(n) || n < 1) ? 15 : n;
}

/**
 * Start the scheduler. Safe to call multiple times.
 *
 * @returns {Promise<{ started: boolean, cron: string|null, queue: string }>}
 */
async function startEngagementScheduler() {
  const enabled = isEnabled(await getConfig('MARKETO_INGEST_ENABLED'));
  if (!enabled) {
    logger.info('[engagement/scheduler] MARKETO_INGEST_ENABLED=false — skipping');
    return { started: false, cron: null, queue: QUEUE_NAME };
  }

  const minutes = intervalMinutes(await getConfig('MARKETO_INGEST_INTERVAL_MIN'));
  const cron    = `*/${minutes} * * * *`;

  await startBoss();
  const boss = getBoss();

  // Subscribe a worker that runs one ingest cycle per dequeued job. teamSize=1
  // because we never want two cycles writing the cursor simultaneously.
  if (!_started) {
    await boss.work(QUEUE_NAME, { teamSize: 1, teamConcurrency: 1 }, async () => {
      const t0 = Date.now();
      try {
        const summary = await runner.runOnce();
        logger.info(
          { ...summary, cycleMs: Date.now() - t0 },
          '[engagement/scheduler] cycle complete',
        );
        return summary;
      } catch (err) {
        logger.error({ err: err.message }, '[engagement/scheduler] cycle failed');
        throw err;
      }
    });
    _started = true;
  }

  // pg-boss v9: schedule(name, cron[, data[, options]]). Re-calling with the
  // same name updates the cron in-place — perfect for our "idempotent" need.
  try {
    await boss.schedule(QUEUE_NAME, cron);
    logger.info({ cron, queue: QUEUE_NAME }, '[engagement/scheduler] scheduled');
  } catch (err) {
    logger.error({ err: err.message, cron }, '[engagement/scheduler] schedule() failed');
    throw err;
  }

  return { started: true, cron, queue: QUEUE_NAME };
}

/**
 * Test helper: drop the "subscribed" flag so the next start re-subscribes.
 */
function _reset() { _started = false; }

module.exports = {
  startEngagementScheduler,
  QUEUE_NAME,
  _reset,
  _isEnabled: isEnabled,
  _intervalMinutes: intervalMinutes,
};
