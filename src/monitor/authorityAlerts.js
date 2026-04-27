'use strict';

const axios        = require('axios');
const logger       = require('../audit/logger');
const { getPool } = require('../audit/db');
const { getConfig } = require('../config/loader');

const DEFAULT_WINDOW_MS   = 5 * 60 * 1000;   // 5 min
const DEFAULT_THRESHOLD   = 10;
const DEFAULT_INTERVAL_MS = 60 * 1000;       // 1 min

// Module-level state: debounce tracking + scheduler handle.
let _lastFiredAt = 0;
let _timer       = null;

/**
 * Query `sync_events` for the number of authority-skip rows in the last
 * `windowMs` milliseconds and fire a webhook alert if the count exceeds
 * `threshold`.
 *
 * Alerts are debounced across calls: once fired, no further alert will be
 * emitted until the current window has elapsed (i.e. `now - _lastFiredAt >=
 * windowMs`), so a single spike produces one page, not one per polling tick.
 *
 * @param {{ windowMs?: number, threshold?: number, now?: number }} [opts]
 * @returns {Promise<{ count: number,
 *                     threshold: number,
 *                     windowMs: number,
 *                     alertFired: boolean,
 *                     firstEvent: string|null,
 *                     lastEvent:  string|null }>}
 */
async function checkAuthoritySkipRate(opts = {}) {
  const windowMs  = opts.windowMs  != null ? opts.windowMs  : DEFAULT_WINDOW_MS;
  const threshold = opts.threshold != null ? opts.threshold : DEFAULT_THRESHOLD;
  const now       = opts.now       != null ? opts.now       : Date.now();

  const since = new Date(now - windowMs).toISOString();

  const { rows } = await getPool().query(
    `SELECT COUNT(*)::int          AS count,
            MIN(created_at)        AS first_event,
            MAX(created_at)        AS last_event
       FROM sync_events
      WHERE reason_category = 'authority'
        AND created_at >= $1`,
    [since],
  );

  const row        = rows[0] || {};
  const count      = row.count || 0;
  const firstEvent = row.first_event ? new Date(row.first_event).toISOString() : null;
  const lastEvent  = row.last_event  ? new Date(row.last_event).toISOString()  : null;

  // Debounce: only fire when (a) over threshold AND (b) last fire was more
  // than one window ago. `now - 0 >= windowMs` on the first ever call so the
  // initial breach always fires.
  const breached       = count > threshold;
  const debounceCleared = (now - _lastFiredAt) >= windowMs;
  const shouldFire     = breached && debounceCleared;

  if (!shouldFire) {
    if (breached && !debounceCleared) {
      logger.info(
        { count, threshold, windowMs, lastFiredAt: _lastFiredAt },
        '[authorityAlerts] threshold breached but debounced — skipping webhook',
      );
    }
    return { count, threshold, windowMs, alertFired: false, firstEvent, lastEvent };
  }

  const webhookUrl = (await getConfig('ALERT_WEBHOOK_URL')) || process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn(
      { count, threshold, windowMs },
      '[authorityAlerts] ALERT_WEBHOOK_URL not configured — alert suppressed',
    );
    // Still advance the debounce clock so we don't spam logs every tick.
    _lastFiredAt = now;
    return { count, threshold, windowMs, alertFired: false, firstEvent, lastEvent };
  }

  const body = {
    kind:       'authority-skip-spike',
    count,
    windowMs,
    threshold,
    firstEvent,
    lastEvent,
  };

  await axios.post(webhookUrl, body);
  _lastFiredAt = now;
  logger.warn(body, '[authorityAlerts] authority-skip spike alert fired');

  return { count, threshold, windowMs, alertFired: true, firstEvent, lastEvent };
}

/**
 * Poll `checkAuthoritySkipRate` every `intervalMs`. Errors are swallowed and
 * logged — the scheduler must never throw into the event loop.
 *
 * Idempotent: calling more than once returns the existing timer handle.
 *
 * @param {{ intervalMs?: number, windowMs?: number, threshold?: number }} [opts]
 * @returns {NodeJS.Timeout}
 */
function startAuthorityAlertScheduler(opts = {}) {
  if (_timer) return _timer;

  const intervalMs = opts.intervalMs != null ? opts.intervalMs : DEFAULT_INTERVAL_MS;
  const windowMs   = opts.windowMs   != null ? opts.windowMs   : DEFAULT_WINDOW_MS;
  const threshold  = opts.threshold  != null ? opts.threshold  : DEFAULT_THRESHOLD;

  logger.info(
    { intervalMs, windowMs, threshold },
    '[authorityAlerts] scheduler started',
  );

  const tick = () => {
    checkAuthoritySkipRate({ windowMs, threshold })
      .catch(err =>
        logger.error(
          { error: err.message },
          '[authorityAlerts] scheduled check failed',
        ),
      );
  };

  // Run immediately, then on each interval.
  tick();
  _timer = setInterval(tick, intervalMs);
  if (_timer.unref) _timer.unref();

  return _timer;
}

/** Stop the scheduler. Primarily for tests + clean shutdown. */
function stopAuthorityAlertScheduler() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

/** Test helper — reset debounce state so each test starts from a clean slate. */
function _resetAuthorityAlertState() {
  _lastFiredAt = 0;
  stopAuthorityAlertScheduler();
}

module.exports = {
  checkAuthoritySkipRate,
  startAuthorityAlertScheduler,
  stopAuthorityAlertScheduler,
  _resetAuthorityAlertState,
};
