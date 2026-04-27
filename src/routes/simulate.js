'use strict';

/**
 * Operator-facing simulation endpoints — let the SPA trigger backend
 * flows that normally only fire on external webhooks. Useful for demos
 * and end-to-end sanity checks without needing a real Marketo Smart
 * Campaign or Dynamics Plugin.
 */

const express = require('express');
const logger  = require('../audit/logger');
const { processJob } = require('../queue/worker');

const router = express.Router();

/**
 * POST /api/simulate/unsubscribe
 * Body: { crmContactId?: string, email?: string, marketoId?: string }
 *
 * Constructs a synthetic Marketo-source job with `unsubscribed: true`
 * and feeds it through the live worker pipeline. Authority guard
 * classifies it as GLOBAL_UNSUBSCRIBE; the unsubscribe handler resolves
 * the Person to a Dynamics Contact and PATCHes `donotbulkemail = true`.
 *
 * Returns the same shape processJob does: `{ status, reason?, targetId? }`.
 */
router.post('/unsubscribe', async (req, res) => {
  const { crmContactId, email, marketoId } = req.body || {};

  if (!crmContactId && !email) {
    return res.status(400).json({
      error: 'crmContactId or email is required to identify the Contact.',
    });
  }

  const payload = {
    unsubscribed: true,
    ...(crmContactId ? { crmContactId } : {}),
    ...(email        ? { email }        : {}),
    ...(marketoId    ? { id: marketoId } : {}),
  };

  const job = {
    id:           `sim-unsub-${Date.now()}`,
    data:         { source: 'marketo', receivedAt: new Date().toISOString(), payload },
    opts:         { attempts: 1 },
    attemptsMade: 1,
  };

  try {
    logger.info({ payload, jobId: job.id }, '[simulate/unsubscribe] running synthetic job');
    const result = await processJob(job);
    res.json({
      ok:        !result.skipped,
      result,
      jobId:     job.id,
      sentBody:  { donotbulkemail: true }, // what gets PATCHed on success
      hint: result.skipped
        ? `Skipped: ${result.reason}. ` +
          (result.reason === 'contact-not-resolvable'
            ? 'No active Dynamics Contact matched. Either the email is on a Lead-only or the Contact was deleted.'
            : 'See the reason — the authority guard rejected the payload.')
        : `Patched donotbulkemail=true on Contact ${result.targetId}.`,
    });
  } catch (err) {
    logger.error({ err: err.message, jobId: job.id }, '[simulate/unsubscribe] failed');
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router };
