'use strict';

const express = require('express');
const logger = require('../audit/logger');
const { enqueue } = require('../queue/producer');
const { QUEUE_NAME } = require('../queue/queue');
const { previewBundle, runBundle, VALID_ENTITIES } = require('../engine/bundleSync');
const { runUnsubscribeAndSync } = require('../engine/unsubscribeBundle');
const { getDynamicsToken } = require('../auth/dynamics');
const { getMarketoToken }  = require('../auth/marketo');

const router = express.Router();

const MAX_BUNDLE_ROWS = 50;

function isValidDirection(d) {
  return d === 'd2m' || d === 'm2d' || d === 'both';
}

function validateBundleBody(body) {
  if (!body || typeof body !== 'object') {
    return { error: 'request body required' };
  }
  if (!body.entity || !VALID_ENTITIES.includes(body.entity)) {
    return { error: `entity must be one of: ${VALID_ENTITIES.join(', ')}` };
  }
  if (!Array.isArray(body.sourceIds) || body.sourceIds.length === 0) {
    return { error: 'sourceIds must be a non-empty array' };
  }
  if (body.sourceIds.length > MAX_BUNDLE_ROWS) {
    return { error: `Too many rows: max ${MAX_BUNDLE_ROWS} per request` };
  }
  return null;
}

router.post('/', async (req, res) => {
  const { direction, entity = 'contact', records } = req.body || {};
  if (!isValidDirection(direction)) {
    return res.status(400).json({ error: 'Missing or invalid direction (d2m|m2d|both)' });
  }
  if (!records || typeof records !== 'object') {
    return res.status(400).json({ error: 'Missing records object' });
  }

  const enqueued = { dynamics: 0, marketo: 0 };
  const jobs = [];
  const errors = [];

  async function push(side, items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      try {
        // Ensure the enqueued payload carries the entity/type so the
        // worker can correctly apply contact-vs-lead mappings/derivations.
        const payloadWithType = Object.assign({}, item, { type: entity });
        const data = {
          source: side,
          receivedAt: new Date().toISOString(),
          payload: payloadWithType,
        };
        const jobId = await enqueue(QUEUE_NAME, data);
        enqueued[side] = (enqueued[side] || 0) + 1;
        const ident = item.email || item.emailaddress1 || item.contactid || item.leadid || item.accountid || null;
        jobs.push({ jobId, side, ident });
      } catch (err) {
        logger.warn({ error: err.message }, '[transfer] enqueue failed');
        errors.push({ side, error: err.message });
      }
    }
  }

  try {
    if ((direction === 'd2m' || direction === 'both') && Array.isArray(records.dynamics)) {
      await push('dynamics', records.dynamics);
    }
    if ((direction === 'm2d' || direction === 'both') && Array.isArray(records.marketo)) {
      await push('marketo', records.marketo);
    }
    res.json({ enqueued, jobs, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/transfer/with-company/preview
 * Body: { entity: 'contact'|'lead', sourceIds: [string, ...] }
 *
 * Read-only — resolves each row's company linkage and returns the projected
 * Account + Person bodies that WOULD be sent. Drives the preview modal.
 */
router.post('/with-company/preview', async (req, res) => {
  const err = validateBundleBody(req.body);
  if (err) return res.status(400).json(err);

  try {
    const dynToken = await getDynamicsToken();
    const mktToken = await getMarketoToken();
    const result = await previewBundle({
      entity:   req.body.entity,
      sourceIds: req.body.sourceIds.map(String),
      dynToken,
      mktToken,
    });
    res.json(result);
  } catch (e) {
    logger.error({ err: e.message }, '[transfer/with-company/preview] failed');
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/transfer/with-company
 * Body: { entity: 'contact'|'lead', sourceIds: [string, ...] }
 *
 * Live sequential push. Each row may produce up to 2 audit rows (Account,
 * Person), tagged reason_category='manual' / reason_criterion='manual:sync-with-company'.
 * Account write failure does NOT abort the row's Person write.
 */
router.post('/with-company', async (req, res) => {
  const err = validateBundleBody(req.body);
  if (err) return res.status(400).json(err);

  try {
    const dynToken = await getDynamicsToken();
    const mktToken = await getMarketoToken();
    const result = await runBundle({
      entity:    req.body.entity,
      sourceIds: req.body.sourceIds.map(String),
      dynToken,
      mktToken,
    });
    logger.info({
      entity:        req.body.entity,
      total:         result.summary.total,
      personsSynced: result.summary.personsSynced,
      accountsSynced: result.summary.accountsSynced,
      skipped:       result.summary.skipped,
      failed:        result.summary.failed,
    }, '[transfer/with-company] complete');
    res.json(result);
  } catch (e) {
    logger.error({ err: e.message }, '[transfer/with-company] failed');
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/transfer/unsubscribe-and-sync
 * Body: { sourceIds: [marketo-lead-id, ...] }
 *
 * Combined operator flow:
 *   1. Update each Marketo Person's `unsubscribed` flag to true.
 *   2. Trigger the same path a real Marketo unsubscribe webhook would —
 *      the authority guard routes to handleGlobalUnsubscribe which PATCHes
 *      the matching Dynamics Contact's `donotbulkemail = true`.
 *
 * Response shape per row: `{ marketoId, email, marketo:{ok,status},
 * dynamics:{ok,contactId,patched}, summary, error? }`. The `summary`
 * field is an operator-friendly one-liner like "Email = Do Not Allow
 * on Dynamics Contact <guid>."
 */
router.post('/unsubscribe-and-sync', async (req, res) => {
  const { sourceIds } = req.body || {};
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    return res.status(400).json({ error: 'sourceIds must be a non-empty array' });
  }
  if (sourceIds.length > MAX_BUNDLE_ROWS) {
    return res.status(400).json({ error: `Too many rows: max ${MAX_BUNDLE_ROWS} per request` });
  }
  try {
    const mktToken = await getMarketoToken();
    const result = await runUnsubscribeAndSync({
      sourceIds: sourceIds.map(String),
      mktToken,
    });
    logger.info({
      total: result.summary.total,
      marketoUpdated: result.summary.marketoUpdated,
      dynamicsPatched: result.summary.dynamicsPatched,
      skipped: result.summary.skipped,
      failed: result.summary.failed,
    }, '[transfer/unsubscribe-and-sync] complete');
    res.json(result);
  } catch (err) {
    logger.error({ err: err.message }, '[transfer/unsubscribe-and-sync] failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, MAX_BUNDLE_ROWS };
