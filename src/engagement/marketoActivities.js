'use strict';

/**
 * Thin wrapper around Marketo's activity-related REST endpoints used by the
 * engagement-ingest pipeline (Doc 2).
 *
 * Mirrors the helper pattern in src/writers/marketoLists.js — single
 * `callMarketo()` core with 429 backoff and axios error unwrapping so the
 * thrown message always carries Marketo's reasons.
 */

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
 * Single chokepoint for every Marketo activity-API call. Mirrors the
 * marketoLists.js pattern so 429 backoff and error shaping behave identically.
 *
 * @param {'GET'|'POST'} method
 * @param {string} path
 * @param {object|null} body
 * @param {string} token
 * @param {string} prefix   - included in any thrown error message
 * @param {number} [_attempt]
 */
async function callMarketo(method, path, body, token, prefix, _attempt = 0) {
  const baseUrl = await getConfig('MARKETO_BASE_URL');
  if (!baseUrl) throw new Error('[engagement/marketoActivities] MARKETO_BASE_URL not set');
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
      logger.warn({ attempt: _attempt + 1, waitMs, path }, '[engagement/marketoActivities] 429 — backing off');
      await sleep(waitMs);
      return callMarketo(method, path, body, token, prefix, _attempt + 1);
    }
    throw unwrapAxiosError(err, prefix);
  }
}

/**
 * Get a paging token to anchor an activity scan to a point in time.
 * Marketo requires this — you can't pass sinceDatetime directly to /activities.
 *
 * @param {string} sinceIso - ISO-8601 string
 * @param {string} token
 * @returns {Promise<{ nextPageToken: string }>}
 */
async function getPagingToken(sinceIso, token) {
  if (!sinceIso) throw new Error('[engagement/marketoActivities] getPagingToken: sinceIso required');
  const path = `/rest/v1/activities/pagingtoken.json?sinceDatetime=${encodeURIComponent(sinceIso)}`;
  const data = await callMarketo('GET', path, null, token, '[engagement/marketoActivities] getPagingToken');
  if (!data?.success || !data.nextPageToken) {
    throw new Error(
      `[engagement/marketoActivities] getPagingToken failed: ${JSON.stringify(data?.errors || data)}`,
    );
  }
  return { nextPageToken: data.nextPageToken };
}

/**
 * Fetch one page of activities for the given activity-type ids.
 *
 * @param {object} params
 * @param {string} params.nextPageToken
 * @param {Array<number|string>} params.activityTypeIds
 * @param {string} params.token
 * @returns {Promise<{ success: boolean, errors?: Array, result: Array, nextPageToken: string, moreResult: boolean }>}
 */
async function fetchActivities({ nextPageToken, activityTypeIds, token }) {
  if (!nextPageToken) throw new Error('[engagement/marketoActivities] fetchActivities: nextPageToken required');
  if (!Array.isArray(activityTypeIds) || activityTypeIds.length === 0) {
    throw new Error('[engagement/marketoActivities] fetchActivities: activityTypeIds required');
  }
  const csv  = activityTypeIds.join(',');
  const path = `/rest/v1/activities.json?nextPageToken=${encodeURIComponent(nextPageToken)}&activityTypeIds=${encodeURIComponent(csv)}`;
  const data = await callMarketo('GET', path, null, token, '[engagement/marketoActivities] fetchActivities');
  return {
    success:        !!data?.success,
    errors:         data?.errors || [],
    result:         Array.isArray(data?.result) ? data.result : [],
    nextPageToken:  data?.nextPageToken || nextPageToken,
    moreResult:     !!data?.moreResult,
  };
}

/**
 * Resolve leadIds → email + name. Marketo caps filterValues at 300 ids per
 * call so we batch internally and concatenate the results.
 *
 * @param {Array<number|string>} leadIds
 * @param {string} token
 * @returns {Promise<Array<{ id: number, email: string, firstName?: string, lastName?: string }>>}
 */
async function fetchLeadEmails(leadIds, token) {
  if (!Array.isArray(leadIds) || leadIds.length === 0) return [];
  const BATCH = 300;
  const out = [];
  for (let i = 0; i < leadIds.length; i += BATCH) {
    const batch = leadIds.slice(i, i + BATCH);
    const csv   = batch.join(',');
    const path  = `/rest/v1/leads.json?filterType=id&filterValues=${encodeURIComponent(csv)}&fields=id,email,firstName,lastName`;
    const data  = await callMarketo('GET', path, null, token, '[engagement/marketoActivities] fetchLeadEmails');
    if (!data?.success) {
      throw new Error(
        `[engagement/marketoActivities] fetchLeadEmails failed: ${JSON.stringify(data?.errors || data)}`,
      );
    }
    for (const row of data.result || []) out.push(row);
  }
  return out;
}

/**
 * Get the list of all activity types provisioned in this Marketo instance.
 * Useful for validating that the types we want to fetch actually exist.
 *
 * @param {string} token
 * @returns {Promise<Array<{ id: number, name: string }>>}
 */
async function getActivityTypes(token) {
  const path = '/rest/v1/activities/types.json';
  const data = await callMarketo('GET', path, null, token, '[engagement/marketoActivities] getActivityTypes');
  if (!data?.success) {
    throw new Error(
      `[engagement/marketoActivities] getActivityTypes failed: ${JSON.stringify(data?.errors || data)}`,
    );
  }
  return Array.isArray(data.result) ? data.result : [];
}

module.exports = {
  getPagingToken,
  getActivityTypes,
  fetchActivities,
  fetchLeadEmails,
  // Exposed for tests that want to drive callMarketo directly
  _callMarketo: callMarketo,
};
