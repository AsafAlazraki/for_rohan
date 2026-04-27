'use strict';

const axios  = require('axios');
const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');

const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_429_RETRIES        = 3;

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

  try {
    const { data: body } = await axios.post(
      `${baseUrl}/rest/v1/leads.json`,
      {
        action:      'createOrUpdate',
        lookupField: 'email',
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
async function writeMarketoCompany(data, token, _attempt = 0) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[writers/marketo] MARKETO_BASE_URL not set');

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
      throw new Error(`[writers/marketo] Company push failed: ${JSON.stringify(body.errors)}`);
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
    throw unwrapAxiosError(err, '[writers/marketo] Company push');
  }
}

module.exports = { writeToMarketo, writeMarketoCompany };
