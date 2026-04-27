'use strict';

/**
 * Outbound webhook dispatcher.
 *
 * This service acts AS a webhook source for downstream consumers. Admins
 * register sinks (URL + secret + filters) in `outbound_webhook_sinks`.
 * When a sync_events row lands, `dispatchEvent()` loads the enabled sinks,
 * filters them against the event's shape, and POSTs the event body to each
 * with an `x-playground-signature: sha256=<hex>` HMAC header over the raw
 * JSON body.
 *
 * Guarantees:
 *   - Never throws. Any failure is caught, logged, and a delivery row is
 *     written with the error. Callers (e.g. logEvent) can safely `await`
 *     this at the tail of a success path, or call it fire-and-forget.
 *   - Per POST timeout: 5s.
 *   - Retries: up to 3 attempts with exponential backoff (250ms, 500ms)
 *     on 5xx and network errors. 4xx responses are NOT retried.
 *   - Concurrency: capped at 10 in-flight deliveries per event when the
 *     matched sink count exceeds 50 (manual semaphore — no external deps).
 */

const axios  = require('axios');
const crypto = require('crypto');
const { getPool } = require('../audit/db');
const logger = require('../audit/logger');

const REQUEST_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS       = 3;
const BACKOFF_BASE_MS    = 250;
const CONCURRENCY_LIMIT  = 10;
const CONCURRENCY_THRESH = 50;

function signBody(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function matchesFilter(arr, value) {
  // Empty / null filter array = "match all".
  if (!arr || !Array.isArray(arr) || arr.length === 0) return true;
  return arr.includes(value);
}

function sinkMatchesEvent(sink, event) {
  return (
    matchesFilter(sink.filter_status,   event.status)        &&
    matchesFilter(sink.filter_category, event.reason_category) &&
    matchesFilter(sink.filter_sources,  event.source_system)
  );
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isRetryable(err, response) {
  if (response && typeof response.status === 'number') {
    return response.status >= 500 && response.status < 600;
  }
  // network / timeout / axios error without response
  return true;
}

/**
 * List all enabled sinks. Filters happen in-JS so operators can see the full
 * set from the Admin UI and so filter semantics stay in one place.
 */
async function listSinks({ enabledOnly = false } = {}) {
  const where = enabledOnly ? 'WHERE enabled = TRUE' : '';
  const { rows } = await getPool().query(
    `SELECT id, name, url, secret,
            filter_status, filter_category, filter_sources,
            enabled, created_at, last_delivery, last_status
       FROM outbound_webhook_sinks
       ${where}
      ORDER BY created_at DESC`,
  );
  return rows;
}

async function getSink(id) {
  const { rows } = await getPool().query(
    `SELECT id, name, url, secret,
            filter_status, filter_category, filter_sources,
            enabled, created_at, last_delivery, last_status
       FROM outbound_webhook_sinks
      WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

async function createSink({ name, url, secret, filter_status, filter_category, filter_sources, enabled }) {
  if (!name || !url || !secret) {
    throw new Error('[outboundDispatcher] name, url, and secret are required');
  }
  const { rows } = await getPool().query(
    `INSERT INTO outbound_webhook_sinks
       (name, url, secret, filter_status, filter_category, filter_sources, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE))
     RETURNING id, name, url, secret,
               filter_status, filter_category, filter_sources,
               enabled, created_at, last_delivery, last_status`,
    [
      name, url, secret,
      filter_status   || null,
      filter_category || null,
      filter_sources  || null,
      enabled === undefined ? null : !!enabled,
    ],
  );
  return rows[0];
}

async function updateSink(id, patch) {
  const allowed = [
    'name', 'url', 'secret',
    'filter_status', 'filter_category', 'filter_sources',
    'enabled',
  ];
  const sets   = [];
  const values = [];
  let   idx    = 1;
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, k)) {
      sets.push(`${k} = $${idx++}`);
      values.push(patch[k]);
    }
  }
  if (sets.length === 0) return getSink(id);
  values.push(id);

  const { rows } = await getPool().query(
    `UPDATE outbound_webhook_sinks
        SET ${sets.join(', ')}
      WHERE id = $${idx}
      RETURNING id, name, url, secret,
                filter_status, filter_category, filter_sources,
                enabled, created_at, last_delivery, last_status`,
    values,
  );
  return rows[0] || null;
}

async function deleteSink(id) {
  const { rowCount } = await getPool().query(
    'DELETE FROM outbound_webhook_sinks WHERE id = $1',
    [id],
  );
  return rowCount > 0;
}

async function listDeliveries({ sinkId, limit = 50 } = {}) {
  const cappedLimit = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
  if (sinkId) {
    const { rows } = await getPool().query(
      `SELECT id, sink_id, event_id, url, status, response_ms, error, attempt, delivered_at
         FROM outbound_webhook_deliveries
        WHERE sink_id = $1
        ORDER BY delivered_at DESC
        LIMIT $2`,
      [sinkId, cappedLimit],
    );
    return rows;
  }
  const { rows } = await getPool().query(
    `SELECT id, sink_id, event_id, url, status, response_ms, error, attempt, delivered_at
       FROM outbound_webhook_deliveries
      ORDER BY delivered_at DESC
      LIMIT $1`,
    [cappedLimit],
  );
  return rows;
}

async function recordDelivery({ sinkId, eventId, url, status, responseMs, error, attempt }) {
  try {
    await getPool().query(
      `INSERT INTO outbound_webhook_deliveries
         (sink_id, event_id, url, status, response_ms, error, attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sinkId, eventId || null, url, status ?? null, responseMs ?? null, error || null, attempt],
    );
  } catch (e) {
    logger.error({ err: e.message, sinkId }, '[outboundDispatcher] failed to record delivery row');
  }

  // Update sink's last_delivery/last_status for quick visibility in the UI.
  try {
    await getPool().query(
      `UPDATE outbound_webhook_sinks
          SET last_delivery = NOW(), last_status = $1
        WHERE id = $2`,
      [status ?? null, sinkId],
    );
  } catch (e) {
    logger.error({ err: e.message, sinkId }, '[outboundDispatcher] failed to stamp sink last_delivery');
  }
}

async function deliverOnce(sink, body, signature) {
  const started = Date.now();
  try {
    const res = await axios.post(sink.url, body, {
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'Content-Type':            'application/json',
        'x-playground-signature':  `sha256=${signature}`,
        'x-playground-event-type': 'sync_event',
      },
      // Let us inspect status rather than throwing on 4xx/5xx.
      validateStatus: () => true,
      // Body is already a string; tell axios not to transform.
      transformRequest: [(data) => data],
    });
    return { status: res.status, responseMs: Date.now() - started, error: null, response: res };
  } catch (err) {
    return {
      status:     null,
      responseMs: Date.now() - started,
      error:      err?.message || 'network error',
      response:   null,
    };
  }
}

async function deliverWithRetry(sink, event, body, signature) {
  let lastAttempt = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await deliverOnce(sink, body, signature);
    lastAttempt = { ...result, attempt };

    const ok = result.status != null && result.status >= 200 && result.status < 300;
    if (ok) {
      await recordDelivery({
        sinkId:     sink.id,
        eventId:    event?.id,
        url:        sink.url,
        status:     result.status,
        responseMs: result.responseMs,
        error:      null,
        attempt,
      });
      return lastAttempt;
    }

    const retryable = isRetryable(null, result.response);
    if (attempt < MAX_ATTEMPTS && retryable) {
      // Backoff before next attempt. Don't record intermediate attempts; the
      // final attempt (whether success or exhausted) writes the delivery row.
      await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1));
      continue;
    }

    // Non-retryable 4xx, or retries exhausted — write the final delivery row.
    await recordDelivery({
      sinkId:     sink.id,
      eventId:    event?.id,
      url:        sink.url,
      status:     result.status,
      responseMs: result.responseMs,
      error:      result.error || (result.status != null ? `HTTP ${result.status}` : 'unknown'),
      attempt,
    });
    return lastAttempt;
  }
  return lastAttempt;
}

/**
 * Run up to `concurrency` async tasks in parallel. Manual semaphore — no
 * external deps per the conventions in this codebase.
 */
async function runWithLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        results[i] = { error: err?.message || String(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Dispatch a sync_events row to every enabled sink whose filters match.
 * Never throws — errors are logged and recorded per-attempt.
 *
 * @param {object} event The sync_events row (must contain id, source_system,
 *                       source_id, target_system, status, reason_category,
 *                       reason_criterion, payload, created_at).
 */
async function dispatchEvent(event) {
  if (!event || typeof event !== 'object') return;
  try {
    const sinks = await listSinks({ enabledOnly: true });
    const matched = sinks.filter(s => sinkMatchesEvent(s, event));
    if (matched.length === 0) return;

    const body = JSON.stringify({
      id:               event.id,
      source_system:    event.source_system,
      source_id:        event.source_id,
      source_type:      event.source_type,
      target_system:    event.target_system,
      target_id:        event.target_id,
      status:           event.status,
      reason_category:  event.reason_category,
      reason_criterion: event.reason_criterion,
      error_message:    event.error_message,
      payload:          event.payload,
      created_at:       event.created_at instanceof Date
                          ? event.created_at.toISOString()
                          : event.created_at,
    });

    const concurrency = matched.length > CONCURRENCY_THRESH ? CONCURRENCY_LIMIT : matched.length;

    await runWithLimit(matched, concurrency, async (sink) => {
      try {
        const signature = signBody(sink.secret, body);
        return await deliverWithRetry(sink, event, body, signature);
      } catch (err) {
        logger.error({ err: err.message, sinkId: sink.id }, '[outboundDispatcher] deliver error');
        // Swallow — never throw from dispatch.
        return { error: err.message };
      }
    });
  } catch (err) {
    logger.error({ err: err.message }, '[outboundDispatcher] dispatchEvent top-level error');
  }
}

module.exports = {
  dispatchEvent,
  listSinks,
  getSink,
  createSink,
  updateSink,
  deleteSink,
  listDeliveries,
  // exported for unit-test introspection
  _internals: { signBody, sinkMatchesEvent, runWithLimit, isRetryable },
};
