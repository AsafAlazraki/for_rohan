
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const CACHE_TTL_MS = 60_000;

// Map<key, { value, fetchedAt }>
const _cache = new Map();
// Timestamp of the most recent full-table refresh. -Infinity means "never".
let _lastBulkRefresh = -Infinity;

/**
 * Pull the entire admin_config table in a single round-trip and stamp every
 * row into the cache. One RTT amortised across every getConfig() call in the
 * same 60-s window.
 *
 * Silently no-ops if PostgreSQL is not configured so callers fall through to
 * process.env.
 */
async function _refreshBulk() {
  try {
    const res = await pool.query('SELECT key, value, is_secret, updated_at FROM admin_config');
    const now = Date.now();
    for (const row of res.rows || []) {
      _cache.set(row.key, { value: row.value, fetchedAt: now });
    }
    _lastBulkRefresh = now;
  } catch (err) {
    console.warn('[config/loader] admin_config fetch failed:', err.message);
  }
}

/**
 * Return the value for a config key.
 *
 * Resolution order:
 *   1. process.env (authoritative — .env wins so local/CI overrides can't be
 *      shadowed by stale admin_config rows)
 *   2. In-memory cache (≤ 60 s old)
 *   3. PostgreSQL admin_config (refreshed in bulk, cached for 60 s)
 *   4. null
 *
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function getConfig(key) {
  const envVal = process.env[key];
  if (envVal != null && envVal !== '') return envVal;

  const cached = _cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  if (Date.now() - _lastBulkRefresh >= CACHE_TTL_MS) {
    await _refreshBulk();
  }

  const fresh = _cache.get(key);
  if (fresh) return fresh.value;

  // Fallback: fetch single key from DB
  try {
    const res = await pool.query('SELECT value FROM admin_config WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      _cache.set(key, { value: res.rows[0].value, fetchedAt: Date.now() });
      return res.rows[0].value;
    }
  } catch (err) {
    console.warn('[config/loader] getConfig DB error:', err.message);
  }
  return null;
}

/**
 * Upsert a single config key. Invalidates its cache entry so the next read
 * sees the new value without waiting for the 60-s refresh.
 *
 * @param {string}  key
 * @param {string}  value
 * @param {boolean} [isSecret=true]
 * @returns {Promise<void>}
 */
async function setConfig(key, value, isSecret = true) {
  try {
    await pool.query(
      `INSERT INTO admin_config (key, value, is_secret, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret, updated_at = NOW()`,
      [key, value, isSecret]
    );
    _cache.set(key, { value, fetchedAt: Date.now() });
  } catch (err) {
    throw new Error(`[config/loader] setConfig DB error: ${err.message}`);
  }
}

/**
 * List every config row. Values for is_secret=true are masked to last 4 chars.
 * @returns {Promise<Array<{key:string,value:string,is_secret:boolean,updated_at:string}>>}
 */
async function listConfig() {
  try {
    const res = await pool.query('SELECT key, value, is_secret, updated_at FROM admin_config ORDER BY key');
    return (res.rows || []).map(row => ({
      ...row,
      value: row.is_secret ? maskSecret(row.value) : row.value,
    }));
  } catch (err) {
    throw new Error(`[config/loader] listConfig DB error: ${err.message}`);
  }
}

function maskSecret(v) {
  if (!v) return '';
  if (v.length <= 4) return '••••';
  return '••••' + v.slice(-4);
}

/** Test helper: drop the cache. */
function _reset() {
  _cache.clear();
  _lastBulkRefresh = -Infinity;
}

module.exports = { getConfig, setConfig, listConfig, maskSecret, _reset, CACHE_TTL_MS };
