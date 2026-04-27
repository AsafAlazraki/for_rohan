'use strict';

/**
 * Operator-triggered "Unsubscribe & Sync" combined flow.
 *
 * For each selected Marketo Person id:
 *   1. Read the Marketo Lead by id (to get email + any crmContactId).
 *   2. PATCH the Marketo Lead's `unsubscribed` flag to true.
 *   3. Run the worker's processJob synthetically with that payload — the
 *      authority router classifies it as GLOBAL_UNSUBSCRIBE and the
 *      handler PATCHes the Dynamics Contact's `donotbulkemail = true`.
 *   4. Compile a per-row result with both step outcomes + a one-line
 *      operator-friendly summary ("Email = Do Not Allow").
 *
 * Sequential — never throws at the top level. Returns
 * `{ summary, results }` shaped like the bundle-sync helper so the
 * frontend can render the same modal pattern.
 */

const {
  readMarketoLeadById,
  markMarketoLeadUnsubscribed,
} = require('../writers/marketo');
const { processJob } = require('../queue/worker');
const logger         = require('../audit/logger');

function summarize(results) {
  return {
    total:              results.length,
    marketoUpdated:     results.filter(r => r.marketo?.ok).length,
    dynamicsPatched:    results.filter(r => r.dynamics?.ok).length,
    skipped:            results.filter(r => r.dynamics && !r.dynamics.ok && !r.error).length,
    failed:             results.filter(r => r.error).length,
  };
}

/**
 * @param {{ sourceIds: Array<string|number>, mktToken: string,
 *           jobIdPrefix?: string }} args
 */
async function runUnsubscribeAndSync({ sourceIds, mktToken, jobIdPrefix = `unsub-${Date.now()}` }) {
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new Error('[unsubscribeBundle] sourceIds must be a non-empty array');
  }
  if (!mktToken) {
    throw new Error('[unsubscribeBundle] mktToken required');
  }

  const results = [];

  for (const rawId of sourceIds) {
    const marketoId = String(rawId);
    const result = {
      marketoId,
      email:        null,
      crmContactId: null,
      identifier:   marketoId,
      marketo:  { ok: false },
      dynamics: null,
      summary:  null,
      error:    null,
    };

    // ── 1. Read Marketo Lead ───────────────────────────────────────────────
    let row;
    try {
      row = await readMarketoLeadById({ marketoId, token: mktToken });
    } catch (err) {
      result.error = `marketo-read-failed: ${err.message}`;
      results.push(result);
      logger.error({ marketoId, err: err.message }, '[unsubscribeBundle] read failed');
      continue;
    }
    if (!row) {
      result.error = 'marketo-lead-not-found';
      results.push(result);
      continue;
    }
    result.email        = row.email || null;
    result.crmContactId = row.crmContactId || null;
    result.identifier   = row.email || marketoId;

    // ── 2. Mark unsubscribed in Marketo ────────────────────────────────────
    try {
      const m = await markMarketoLeadUnsubscribed({ marketoId, token: mktToken });
      result.marketo = { ok: true, status: m.status, marketoId: m.marketoId };
    } catch (err) {
      result.error = `marketo-update-failed: ${err.message}`;
      result.marketo = { ok: false, error: err.message };
      results.push(result);
      logger.error({ marketoId, err: err.message }, '[unsubscribeBundle] marketo update failed');
      continue;
    }

    // ── 3. Run synthetic processJob to drive Dynamics PATCH ────────────────
    const payload = {
      id:           marketoId,
      unsubscribed: true,
      ...(row.email        ? { email:        row.email }        : {}),
      ...(row.crmContactId ? { crmContactId: row.crmContactId } : {}),
    };
    const job = {
      id:           `${jobIdPrefix}-${marketoId}`,
      data:         { source: 'marketo', receivedAt: new Date().toISOString(), payload },
      opts:         { attempts: 1 },
      attemptsMade: 1,
    };

    try {
      const r = await processJob(job);
      if (r.skipped) {
        result.dynamics = { ok: false, reason: r.reason };
        result.summary  = `Marketo updated; Dynamics skipped (${r.reason}). No CRM Contact change.`;
      } else {
        result.dynamics = {
          ok:                true,
          contactId:         r.targetId,
          donotbulkemail:    true,
          patched:           { donotbulkemail: true },
        };
        result.summary = `Email = Do Not Allow on Dynamics Contact ${r.targetId}.`;
      }
    } catch (err) {
      result.error    = `dynamics-patch-failed: ${err.message}`;
      result.dynamics = { ok: false, error: err.message };
      logger.error({ marketoId, err: err.message }, '[unsubscribeBundle] dynamics patch failed');
    }

    results.push(result);
  }

  return { summary: summarize(results), results };
}

module.exports = { runUnsubscribeAndSync };
