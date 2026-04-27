'use strict';

const axios  = require('axios');
const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');
const { fetchLeadSchemaFields } = require('../auth/marketoSchema');

const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_429_RETRIES        = 3;
const LEAD_SCHEMA_TTL_MS     = 60 * 60 * 1000; // 1h

// ── Lead-schema cache + unknown-field filter ────────────────────────────────
// Marketo rejects a Lead push (per-record `status: 'skipped'`, error 1006)
// if the payload references a field that was never defined in Marketo's
// Field Management. To keep the integration "just works" even before the
// operator creates custom fields like crmEntityType / crmContactId, we fetch
// the lead schema once per hour and silently drop unknown keys with a
// one-time WARN per missing field. Operators can later create the fields
// (Admin tab → "Set up Marketo fields", `POST /api/marketo/setup-custom-fields`,
// or `node scripts/marketo-create-custom-fields.js`) and the next sync
// after cache TTL expires will start sending them.
let _leadSchemaCache    = null;     // Set<string> | null
let _leadSchemaCachedAt = 0;
const _missingFieldsWarned = new Set();

function _resetLeadSchemaCache() {
  _leadSchemaCache    = null;
  _leadSchemaCachedAt = 0;
  _missingFieldsWarned.clear();
}

async function fetchLeadSchema(baseUrl, token) {
  const now = Date.now();
  if (_leadSchemaCache && (now - _leadSchemaCachedAt) < LEAD_SCHEMA_TTL_MS) {
    return _leadSchemaCache;
  }
  const fresh = await fetchLeadSchemaFields({ baseUrl, token });
  if (fresh) {
    _leadSchemaCache    = fresh;
    _leadSchemaCachedAt = now;
  }
  return fresh;
}

function filterUnknownLeadFields(payload, schema) {
  if (!schema || !payload || typeof payload !== 'object') return payload;
  const out = {};
  for (const [k, v] of Object.entries(payload)) {
    if (schema.has(k)) {
      out[k] = v;
    } else if (!_missingFieldsWarned.has(k)) {
      _missingFieldsWarned.add(k);
      logger.warn(
        { field: k },
        '[writers/marketo] field not in Marketo lead schema — dropping. ' +
          'Click "Set up Marketo fields" in the SPA admin row, or run ' +
          '`node scripts/marketo-create-custom-fields.js` to create them.',
      );
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfter(header) {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = parseInt(header, 10);
  return isNaN(secs) ? DEFAULT_RETRY_AFTER_MS : secs * 1000;
}

/**
 * Axios' default error message is "Request failed with status code 401" — not
 * useful. Marketo returns rich bodies like
 *   { success:false, errors:[{code:'601', message:'Access token invalid'}] }
 * or plain-text HTML on 5xx. Unwrap the response so the thrown message carries
 * what actually went wrong.
 */
function unwrapAxiosError(err, prefix) {
  if (!err || !err.response) return err;
  const { status, data } = err.response;
  let detail;
  if (data && typeof data === 'object') {
    if (Array.isArray(data.errors) && data.errors.length) {
      detail = data.errors.map(e => `${e.code || '?'}:${e.message || JSON.stringify(e)}`).join('; ');
    } else if (data.message) {
      detail = data.message;
    } else {
      try { detail = JSON.stringify(data); } catch { detail = String(data); }
    }
  } else if (typeof data === 'string' && data.trim()) {
    detail = data.trim().slice(0, 500);
  }
  const msg = detail
    ? `${prefix} HTTP ${status}: ${detail}`
    : `${prefix} HTTP ${status}`;
  const wrapped = new Error(msg);
  wrapped.response = err.response;
  wrapped.original = err;
  return wrapped;
}

/**
 * Write a lead to Marketo using the push endpoint.
 * Handles 429 rate-limit responses with Retry-After back-off.
 *
 * @param {object} data        - Marketo field map (must include `email`)
 * @param {string} token       - Bearer access token
 * @param {number} [_attempt]  - Internal retry counter (do not pass manually)
 * @returns {Promise<{ targetId: string|null, status: string }>}
 */
async function writeToMarketo(data, token, _attempt = 0) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[writers/marketo] MARKETO_BASE_URL not set');

  // Drop fields Marketo's Lead schema doesn't define — would otherwise fail
  // the whole record with `1006:Field 'X' not found`. Schema is cached 1h.
  const schema   = await fetchLeadSchema(baseUrl, token);
  const filtered = filterUnknownLeadFields(data, schema);

  try {
    const { data: body } = await axios.post(
      `${baseUrl}/rest/v1/leads.json`,
      {
        action:      'createOrUpdate',
        lookupField: 'email',
        input:       [filtered],
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!body.success) {
      throw new Error(`[writers/marketo] Push failed: ${JSON.stringify(body.errors)}`);
    }

    const hit = body.result?.[0];
    if (!hit) {
      throw new Error('[writers/marketo] Push returned empty result set');
    }
    if (hit.status === 'skipped' || hit.status === 'failed') {
      // Marketo returns success:true with per-record status when individual
      // records are rejected (field not found, invalid value, etc). Surface
      // these as hard errors so the worker retries / DLQs them properly and
      // the UI actually shows what went wrong.
      const reasons = Array.isArray(hit.reasons) && hit.reasons.length
        ? hit.reasons.map(r => `${r.code}:${r.message}`).join('; ')
        : 'no reason given';
      throw new Error(`[writers/marketo] Lead ${hit.status}: ${reasons}`);
    }
    return {
      targetId: hit.id != null ? String(hit.id) : null,
      status:   hit.status,
    };
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn(
        { attempt: _attempt + 1, waitMs },
        '[writers/marketo] 429 rate-limited — backing off',
      );
      await sleep(waitMs);
      return writeToMarketo(data, token, _attempt + 1);
    }
    throw unwrapAxiosError(err, '[writers/marketo] Push');
  }
}

/**
 * Write a company (account) to Marketo via /rest/v1/companies/sync.json.
 *
 * @param {object} data        - Mapped company fields (must include `company` for lookup)
 * @param {string} token       - Bearer token
 * @param {number} [_attempt]
 * @returns {Promise<{ targetId: string|null, status: string }>}
 */
// Some Marketo tenants don't expose the Companies sync endpoint at all
// (subscription tier, API permissions, or tenant config). We detect this once
// per process and switch to a cached "unavailable" mode so subsequent
// company pushes return a soft `skipped` result instead of repeatedly
// hammering a 404. Lead pushes still work, and Marketo auto-creates the
// Company on the fly via `lead.company` dedup.
let _companiesEndpointUnavailable = false;
let _companiesUnavailableWarned   = false;

function isCompaniesEndpointMissing(err) {
  const status = err?.response?.status;
  if (status === 404 || status === 405) return true;
  // Marketo error code 610 = "Requested resource not found"
  const errors = err?.response?.data?.errors;
  if (Array.isArray(errors) && errors.some(e => String(e.code) === '610')) return true;
  return false;
}

function _resetCompaniesEndpointFlag() {
  _companiesEndpointUnavailable = false;
  _companiesUnavailableWarned   = false;
}

async function writeMarketoCompany(data, token, _attempt = 0) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[writers/marketo] MARKETO_BASE_URL not set');

  if (_companiesEndpointUnavailable) {
    return { targetId: null, status: 'skipped', reason: 'companies-endpoint-unavailable' };
  }

  try {
    const { data: body } = await axios.post(
      `${baseUrl}/rest/v1/companies/sync.json`,
      {
        action:      'createOrUpdate',
        dedupeBy:    'dedupeFields',
        input:       [data],
      },
      {
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!body.success) {
      // success:false at the envelope level with a 610 error means the
      // endpoint isn't present on this tenant — flip the unavailable flag.
      const errors = body.errors || [];
      if (errors.some(e => String(e.code) === '610')) {
        _companiesEndpointUnavailable = true;
        if (!_companiesUnavailableWarned) {
          _companiesUnavailableWarned = true;
          logger.warn(
            '[writers/marketo] Companies endpoint not available on this tenant — ' +
            'subsequent Company writes will be soft-skipped. Lead pushes carry the ' +
            '`company` field; Marketo will create/match the Company on the fly via dedup.',
          );
        }
        return { targetId: null, status: 'skipped', reason: 'companies-endpoint-unavailable' };
      }
      throw new Error(`[writers/marketo] Company push failed: ${JSON.stringify(errors)}`);
    }

    const hit = body.result?.[0];
    if (!hit) {
      throw new Error('[writers/marketo] Company push returned empty result set');
    }
    if (hit.status === 'skipped' || hit.status === 'failed') {
      const reasons = Array.isArray(hit.reasons) && hit.reasons.length
        ? hit.reasons.map(r => `${r.code}:${r.message}`).join('; ')
        : 'no reason given';
      throw new Error(`[writers/marketo] Company ${hit.status}: ${reasons}`);
    }
    return {
      targetId: hit.id != null ? String(hit.id) : null,
      status:   hit.status,
    };
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn(
        { attempt: _attempt + 1, waitMs },
        '[writers/marketo] 429 rate-limited (company) — backing off',
      );
      await sleep(waitMs);
      return writeMarketoCompany(data, token, _attempt + 1);
    }
    if (isCompaniesEndpointMissing(err)) {
      _companiesEndpointUnavailable = true;
      if (!_companiesUnavailableWarned) {
        _companiesUnavailableWarned = true;
        logger.warn(
          '[writers/marketo] Companies endpoint returned 404/405 — disabling company writes for this process. ' +
          'Lead pushes will still set `company` so Marketo can dedup the Company itself.',
        );
      }
      return { targetId: null, status: 'skipped', reason: 'companies-endpoint-unavailable' };
    }
    throw unwrapAxiosError(err, '[writers/marketo] Company push');
  }
}

module.exports = { writeToMarketo, writeMarketoCompany };
