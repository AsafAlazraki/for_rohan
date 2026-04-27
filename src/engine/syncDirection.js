'use strict';

const { getConfig } = require('../config/loader');

const VALID = new Set(['bidirectional', 'dynamics-to-marketo', 'marketo-to-dynamics']);
const DEFAULT = 'bidirectional';

function normalize(raw) {
  if (!raw) return DEFAULT;
  const v = String(raw).toLowerCase().trim();
  return VALID.has(v) ? v : DEFAULT;
}

async function getSyncDirection() {
  return normalize(await getConfig('SYNC_DIRECTION'));
}

/**
 * Decide whether a job going from `source` → `target` is allowed under the
 * configured direction. Returns { skip, reason }.
 *
 * bidirectional         → everything allowed
 * dynamics-to-marketo   → only source=dynamics allowed
 * marketo-to-dynamics   → only source=marketo  allowed
 */
function shouldSkipByDirection(source, direction) {
  const d = normalize(direction);
  if (d === 'bidirectional') return { skip: false };

  const src = String(source || '').toLowerCase().trim();
  if (d === 'dynamics-to-marketo' && src !== 'dynamics') {
    return { skip: true, reason: 'Sync direction is one-way Dynamics → Marketo; skipping Marketo-sourced event' };
  }
  if (d === 'marketo-to-dynamics' && src !== 'marketo') {
    return { skip: true, reason: 'Sync direction is one-way Marketo → Dynamics; skipping Dynamics-sourced event' };
  }
  return { skip: false };
}

module.exports = { getSyncDirection, shouldSkipByDirection, VALID, DEFAULT };
