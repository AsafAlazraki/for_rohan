'use strict';

/**
 * Cursor persistence for the Marketo engagement-ingest pipeline.
 *
 * Marketo's activity APIs are paged via `nextPageToken`. We persist the most
 * recent token in admin_config so the scheduler picks up where the last
 * cycle left off — even across restarts.
 *
 * Stored under key MARKETO_ENGAGEMENT_CURSOR (non-secret so the operator can
 * inspect / reset via the Admin UI).
 */

const { getConfig, setConfig } = require('../config/loader');
// Removed PostgreSQL client import

const KEY = 'MARKETO_ENGAGEMENT_CURSOR';

/**
 * Return the persisted cursor or null when none exists yet.
 * @returns {Promise<string|null>}
 */
async function getCursor() {
  const v = await getConfig(KEY);
  return v && v.length ? v : null;
}

/**
 * Persist a cursor. Stored as non-secret so it's inspectable from /api/config.
 * @param {string} token
 */
async function setCursor(token) {
  if (!token) throw new Error('[engagement/cursor] setCursor: token required');
  await setConfig(KEY, String(token), false);
}

/**
 * Drop the cursor. Subsequent runs re-initialise with `now - lookback`.
 * Implemented as a delete (rather than empty-string set) so the row really
 * disappears from admin_config.
 */
async function clearCursor() {
  // Remove the cursor from admin_config
  const { getPool } = require('../audit/db');
  await getPool().query('DELETE FROM admin_config WHERE key = $1', [KEY]);
}

module.exports = { getCursor, setCursor, clearCursor, KEY };
