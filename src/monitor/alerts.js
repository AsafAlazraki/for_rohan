'use strict';

const axios  = require('axios');
const logger = require('../audit/logger');
const { getDLQDepth, getErrorRate } = require('./metrics');

const DLQ_THRESHOLD        = parseInt(process.env.ALERT_DLQ_THRESHOLD        || '10',   10);
const ERROR_RATE_THRESHOLD = parseFloat(process.env.ALERT_ERROR_RATE_THRESHOLD || '0.05');
const HEARTBEAT_MS         = parseInt(process.env.ALERT_HEARTBEAT_MS           || '60000', 10);

/**
 * Post an alert message to the configured Slack (or generic) webhook.
 * Silently skips if ALERT_WEBHOOK_URL is not set.
 *
 * @param {string} message
 */
async function sendAlert(message) {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) {
    logger.warn({ message }, '[alerts] ALERT_WEBHOOK_URL not configured — alert suppressed');
    return;
  }
  await axios.post(webhookUrl, { text: `[dynamics-marketo-sync] ALERT: ${message}` });
}

/**
 * Run one evaluation cycle: check DLQ depth and error rate,
 * fire alerts for any threshold breaches.
 *
 * @returns {Promise<{ dlqDepth: number, errorRate: number, alertsFired: number }>}
 */
async function checkAndAlert() {
  const [dlqDepth, { errorRate, failedCount, totalCount }] = await Promise.all([
    getDLQDepth(),
    getErrorRate(15),
  ]);

  const messages = [];

  if (dlqDepth > DLQ_THRESHOLD) {
    messages.push(
      `DLQ depth ${dlqDepth} exceeds threshold ${DLQ_THRESHOLD}`,
    );
  }

  if (errorRate > ERROR_RATE_THRESHOLD) {
    messages.push(
      `Error rate ${(errorRate * 100).toFixed(1)}% (${failedCount}/${totalCount} in last 15 min) exceeds threshold ${(ERROR_RATE_THRESHOLD * 100).toFixed(1)}%`,
    );
  }

  for (const msg of messages) {
    logger.warn({ msg }, '[alerts] Threshold breached — sending alert');
    await sendAlert(msg);
  }

  return { dlqDepth, errorRate, alertsFired: messages.length };
}

let _timer = null;

/**
 * Start the 60-second monitoring heartbeat.
 * Idempotent — calling more than once has no effect.
 *
 * @returns {NodeJS.Timeout}
 */
function startMonitor() {
  if (_timer) return _timer;

  logger.info(`[alerts] Monitor started (interval: ${HEARTBEAT_MS} ms)`);

  // Run immediately, then on each interval tick
  checkAndAlert().catch(err =>
    logger.error({ error: err.message }, '[alerts] Initial heartbeat check failed'),
  );

  _timer = setInterval(() => {
    checkAndAlert().catch(err =>
      logger.error({ error: err.message }, '[alerts] Heartbeat check failed'),
    );
  }, HEARTBEAT_MS);

  // Don't block process exit
  if (_timer.unref) _timer.unref();

  return _timer;
}

/** Stop the heartbeat (primarily for tests and clean shutdown). */
function stopMonitor() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { sendAlert, checkAndAlert, startMonitor, stopMonitor };
