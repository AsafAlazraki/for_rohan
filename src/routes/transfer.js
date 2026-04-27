'use strict';

const express = require('express');
const logger = require('../audit/logger');
const { enqueue } = require('../queue/producer');
const { QUEUE_NAME } = require('../queue/queue');
const { previewBundle, runBundle, VALID_ENTITIES } = require('../engine/bundleSync');
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

module.exports = { router, MAX_BUNDLE_ROWS };
