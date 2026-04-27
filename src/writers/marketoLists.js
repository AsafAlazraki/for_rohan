'use strict';

const axios  = require('axios');
const logger = require('../audit/logger');
const { getConfig } = require('../config/loader');

const DEFAULT_RETRY_AFTER_MS = 10_000;
const MAX_429_RETRIES        = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseRetryAfter(header) {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const secs = parseInt(header, 10);
  return isNaN(secs) ? DEFAULT_RETRY_AFTER_MS : secs * 1000;
}

/** Mirror of writers/marketo.js — turn axios errors into useful messages. */
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
 * Marketo's per-record results (status: 'created'|'updated'|'skipped'|'failed')
 * carry their own reasons array. Convert non-success statuses into thrown
 * errors so callers see what really went wrong.
 */
function reasonsString(hit) {
  return Array.isArray(hit?.reasons) && hit.reasons.length
    ? hit.reasons.map(r => `${r.code}:${r.message}`).join('; ')
    : 'no reason given';
}

async function callMarketo(method, path, body, token, prefix, _attempt = 0) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[writers/marketoLists] MARKETO_BASE_URL not set');
  try {
    const { data } = await axios.request({
      method,
      url: `${baseUrl}${path}`,
      data: body,
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
    return data;
  } catch (err) {
    if (err.response?.status === 429 && _attempt < MAX_429_RETRIES) {
      const waitMs = parseRetryAfter(err.response.headers?.['retry-after']);
      logger.warn({ attempt: _attempt + 1, waitMs, path }, '[writers/marketoLists] 429 — backing off');
      await sleep(waitMs);
      return callMarketo(method, path, body, token, prefix, _attempt + 1);
    }
    throw unwrapAxiosError(err, prefix);
  }
}

/**
 * Create a Named Account List.
 *
 * Requires Marketo Account-Based Marketing (ABM). Tenants without ABM will
 * get a permission/404 error which the caller surfaces to the UI verbatim.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} [params.description]
 * @param {string} params.token  - Bearer access token
 * @returns {Promise<{ listId: string, name: string }>}
 */
async function createNamedAccountList({ name, description, token }) {
  if (!name) throw new Error('[writers/marketoLists] createNamedAccountList: name is required');

  const body = { input: [{ name, description: description || '' }] };
  const data = await callMarketo(
    'POST',
    '/rest/v1/namedaccountlists.json',
    body,
    token,
    '[writers/marketoLists] createNamedAccountList',
  );

  if (!data.success) {
    throw new Error(
      `[writers/marketoLists] Create list failed: ${JSON.stringify(data.errors || [])}`,
    );
  }
  const hit = data.result?.[0];
  if (!hit || !hit.id) {
    throw new Error('[writers/marketoLists] Create list returned no id');
  }
  if (hit.status === 'skipped' || hit.status === 'failed') {
    throw new Error(`[writers/marketoLists] List ${hit.status}: ${reasonsString(hit)}`);
  }
  return { listId: String(hit.id), name: hit.name || name };
}

/**
 * Upsert one or more Named Accounts. Dedupes by `name` (Marketo's default
 * dedupe field for Named Accounts).
 *
 * @param {object} params
 * @param {Array<object>} params.accounts  - Each must have `name`; other fields optional.
 * @param {string} params.token
 * @returns {Promise<Array<{ name: string, namedAccountId: string|null, status: string, error?: string }>>}
 */
async function upsertNamedAccounts({ accounts, token }) {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];

  const body = {
    action:   'createOrUpdate',
    dedupeBy: 'dedupeFields',
    input:    accounts.map(a => ({ name: a.name, ...a })),
  };
  const data = await callMarketo(
    'POST',
    '/rest/v1/namedaccounts.json',
    body,
    token,
    '[writers/marketoLists] upsertNamedAccounts',
  );
  if (!data.success) {
    throw new Error(
      `[writers/marketoLists] Upsert named accounts failed: ${JSON.stringify(data.errors || [])}`,
    );
  }
  return (data.result || []).map((hit, i) => {
    const name = accounts[i]?.name;
    if (hit.status === 'skipped' || hit.status === 'failed') {
      return {
        name,
        namedAccountId: hit.id != null ? String(hit.id) : null,
        status:         hit.status,
        error:          reasonsString(hit),
      };
    }
    return {
      name,
      namedAccountId: hit.id != null ? String(hit.id) : null,
      status:         hit.status,
    };
  });
}

/**
 * Add a set of Named Accounts (by Marketo id) to a Named Account List.
 *
 * @param {object} params
 * @param {string} params.listId
 * @param {Array<string>} params.namedAccountIds
 * @param {string} params.token
 * @returns {Promise<Array<{ id: string, status: string, error?: string }>>}
 */
async function addNamedAccountsToList({ listId, namedAccountIds, token }) {
  if (!listId) throw new Error('[writers/marketoLists] addNamedAccountsToList: listId required');
  if (!Array.isArray(namedAccountIds) || namedAccountIds.length === 0) return [];

  const body = { input: namedAccountIds.map(id => ({ id: Number(id) })) };
  const data = await callMarketo(
    'POST',
    `/rest/v1/namedaccountlists/${encodeURIComponent(listId)}/namedaccounts.json`,
    body,
    token,
    '[writers/marketoLists] addNamedAccountsToList',
  );
  if (!data.success) {
    throw new Error(
      `[writers/marketoLists] Add to list failed: ${JSON.stringify(data.errors || [])}`,
    );
  }
  return (data.result || []).map((hit, i) => {
    const id = String(namedAccountIds[i]);
    if (hit.status === 'skipped' || hit.status === 'failed') {
      return { id, status: hit.status, error: reasonsString(hit) };
    }
    return { id, status: hit.status || 'added' };
  });
}

module.exports = {
  createNamedAccountList,
  upsertNamedAccounts,
  addNamedAccountsToList,
};
