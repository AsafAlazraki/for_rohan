'use strict';

/**
 * Orchestrator for one Marketo-engagement poll cycle.
 *
 * Flow:
 *   1. Resolve cursor (or initialise from now - lookback)
 *   2. Page through /activities until moreResult=false or 1000 cap
 *   3. Resolve unique leadIds → emails
 *   4. For each (activity + email): dedup against Dynamics → contactId
 *   5. Apply per-type filter rules
 *   6. Write each "to write" as a Marketing Engagement Activity record;
 *      record decision in engagement_dedup
 *   7. Persist updated cursor + last-run summary
 *
 * Returns a per-cycle summary so the route handlers can echo it back to the UI.
 */

const logger = require('../audit/logger');
const { getConfig, setConfig } = require('../config/loader');
const { getMarketoToken }      = require('../auth/marketo');
const { getDynamicsToken }     = require('../auth/dynamics');
const { resolveAction }        = require('../engine/dedup');
const { emitSync }             = require('../events/bus');
const cursor   = require('./cursor');
const activities = require('./marketoActivities');
const writer  = require('./activityWriter');
const filter  = require('./activityFilter');
const dedupDb = require('./dedupDb');

// All 6 supported activity types per the Doc 2 contract.
const ACTIVITY_TYPE_IDS = [7, 10, 9, 2, 1, 14];

// Safety cap so a wildly out-of-date cursor can't tie up the worker forever.
const MAX_ACTIVITIES_PER_RUN = 1000;

// admin_config keys
const KEY_LAST_RUN  = 'MARKETO_ENGAGEMENT_LAST_RUN';
const KEY_KEY_URLS  = 'MARKETO_WEB_VISIT_KEY_URLS';
const KEY_LOOKBACK  = 'MARKETO_INGEST_LOOKBACK_HOURS';

// In dry-run mode we cap the per-cycle preview list so a backlog doesn't
// balloon the response payload (UI only renders a handful anyway).
const DRY_RUN_SAMPLE_CAP = 20;

// Per-doc activity-type labels (kept in sync with activityWriter.TYPE_LABELS,
// but inlined here so dry-run sample shaping doesn't pull in the writer.)
const TYPE_LABELS = {
  1:  'Web Visit',
  2:  'Form Submit',
  7:  'Email Delivered',
  9:  'Email Click',
  10: 'Email Open',
  14: 'Campaign Response',
};

function isoSinceLookback(hours) {
  const h = parseInt(hours, 10);
  const d = new Date(Date.now() - (isNaN(h) || h <= 0 ? 24 : h) * 3600 * 1000);
  return d.toISOString();
}

/**
 * Push a sync event onto the in-process bus. Defensive — bus listeners must
 * never crash the runner.
 */
function safeEmit(evt) {
  try { emitSync(evt); } catch (e) { logger.warn({ err: e.message }, '[engagement/runner] emit failed'); }
}

/**
 * Run a single engagement-ingest cycle.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false]
 *   When true: preview-only mode. Marketo READS are still real (this matches
 *   the SIM-mode policy across the repo — see Sync View). Dynamics WRITES are
 *   gated: no engagement-activity POSTs, no cursor advance, and no
 *   `'written'` rows are inserted into `engagement_dedup`.
 *   Skipped/unmatched decisions are also collected in-memory only — keeps
 *   the dry-run truly side-effect-free.
 *   The summary will include a `samples` array of up to 20 activities that
 *   would have been written.
 *
 * @returns {Promise<{
 *   fetched: number,
 *   written: number,
 *   skipped: number,
 *   unmatched: number,
 *   durationMs: number,
 *   lastCursor: string|null,
 *   samples?: Array<object>
 * }>}
 */
async function runOnce(opts = {}) {
  const dryRun = !!opts.dryRun;
  const startedAt = Date.now();
  const summary = {
    fetched:    0,
    written:    0,
    skipped:    0,
    unmatched:  0,
    failed:     0,
    durationMs: 0,
    lastCursor: null,
  };
  // Only populated in dry-run mode. Capped at DRY_RUN_SAMPLE_CAP.
  const samples = [];
  function pushSample(activity, decision, opts2 = {}) {
    if (!dryRun) return;
    if (samples.length >= DRY_RUN_SAMPLE_CAP) return;
    samples.push({
      marketoActivityId: activity?.id != null ? String(activity.id) : null,
      type:              activity?.activityTypeId,
      typeName:          TYPE_LABELS[activity?.activityTypeId] || `Type ${activity?.activityTypeId}`,
      contactEmail:      opts2.email || null,
      assetName:         activity?.primaryAttributeValue || null,
      occurredAt:        activity?.activityDate || null,
      decision,
      ...(opts2.reason ? { reason: opts2.reason } : {}),
    });
  }
  // In dry-run we want the runner's behaviour to be observable from tests
  // (insertDedup must NOT be called for 'written'); wrapping safeInsertDedup
  // means we can also short-circuit skipped/unmatched insertion.
  const insertDedupIfReal = dryRun
    ? async () => {}
    : safeInsertDedup;

  let mktoToken;
  try {
    mktoToken = await getMarketoToken();
  } catch (e) {
    summary.durationMs = Date.now() - startedAt;
    logger.error({ err: e.message }, '[engagement/runner] Marketo auth failed');
    await persistLastRun(summary, e.message);
    throw e;
  }

  // ── 1. Resolve cursor ────────────────────────────────────────────────────
  let token = await cursor.getCursor();
  if (!token) {
    const lookbackHours = await getConfig(KEY_LOOKBACK);
    const since = isoSinceLookback(lookbackHours);
    logger.info({ since }, '[engagement/runner] no cursor — initialising paging token');
    const init = await activities.getPagingToken(since, mktoToken);
    token = init.nextPageToken;
  }

  // ── 1b. Validate Activity IDs ───────────────────────────────────────────
  // Some Marketo instances may not have all 6 default types provisioned (e.g. ID 14).
  // We fetch the instance's types and only poll those that actually exist.
  const allTypes = await activities.getActivityTypes(mktoToken);
  const activeIds = allTypes.map(t => t.id);
  const validIds  = ACTIVITY_TYPE_IDS.filter(id => activeIds.includes(id));
  const missing   = ACTIVITY_TYPE_IDS.filter(id => !activeIds.includes(id));

  if (missing.length > 0) {
    logger.warn({ missing }, '[engagement/runner] some supported types missing in this Marketo instance; skipping them');
  }
  if (validIds.length === 0) {
    logger.error('[engagement/runner] NONE of the supported activity types exist in this Marketo instance!');
    summary.durationMs = Date.now() - startedAt;
    return summary;
  }

  // ── 2. Page through activities ───────────────────────────────────────────
  const fetched = [];
  let pages = 0;
  while (fetched.length < MAX_ACTIVITIES_PER_RUN) {
    pages += 1;
    const page = await activities.fetchActivities({
      nextPageToken:  token,
      activityTypeIds: validIds,
      token:          mktoToken,
    });
    if (!page.success) {
      throw new Error(
        `[engagement/runner] fetchActivities failed: ${JSON.stringify(page.errors || [])}`,
      );
    }
    for (const a of page.result) {
      fetched.push(a);
      if (fetched.length >= MAX_ACTIVITIES_PER_RUN) break;
    }
    token = page.nextPageToken;
    if (!page.moreResult) break;
  }
  summary.fetched    = fetched.length;
  summary.lastCursor = token;
  logger.info({ pages, fetched: fetched.length }, '[engagement/runner] paging done');

  if (fetched.length === 0) {
    // In dry-run we never advance the cursor — the next real run still
    // picks up these (zero) activities. Same applies to last-run persistence
    // since we don't want a preview cycle to overwrite the audit trail of
    // the last *real* cycle.
    if (!dryRun) {
      await cursor.setCursor(token);
      await persistLastRun(summary);
    }
    summary.durationMs = Date.now() - startedAt;
    if (dryRun) summary.samples = samples;
    return summary;
  }

  // ── 3. Resolve leadIds → emails ──────────────────────────────────────────
  const leadIds = [...new Set(fetched.map(a => a.leadId).filter(Boolean))];
  let leads = [];
  try {
    leads = await activities.fetchLeadEmails(leadIds, mktoToken);
  } catch (e) {
    logger.error({ err: e.message }, '[engagement/runner] fetchLeadEmails failed');
    throw e;
  }
  const emailByLead = new Map();
  for (const l of leads) {
    if (l && l.id != null && l.email) emailByLead.set(l.id, l.email);
  }

  // ── 4. Apply per-type filter ─────────────────────────────────────────────
  const webVisitKeyUrls = (await getConfig(KEY_KEY_URLS)) || '';
  const { toWrite, toSkip } = await filter.filterActivities(fetched, {
    db: dedupDb,
    webVisitKeyUrls,
  });

  // Persist skipped rows up-front so they show up in /api/engagement/recent.
  // Dry-run: skip the insert but still count + emit an SSE preview event.
  for (const { activity, reason } of toSkip) {
    summary.skipped += 1;
    await insertDedupIfReal({
      marketoActivityId: activity.id,
      activityTypeId:    activity.activityTypeId,
      marketoLeadId:     activity.leadId,
      assetName:         activity.primaryAttributeValue,
      url:               getUrlAttr(activity),
      filterDecision:    'skipped',
      filterReason:      reason,
      occurredAt:        activity.activityDate,
    });
    pushSample(activity, 'skipped', { email: emailByLead.get(activity.leadId), reason });
    safeEmit({
      id:         String(activity.id),
      source:     'marketo',
      target:     'dynamics',
      status:     dryRun ? 'preview' : 'skipped',
      payload:    activity,
      email:      emailByLead.get(activity.leadId) || null,
      entityType: 'engagement',
      reason,
    });
  }

  // ── 5. Resolve contacts + write ──────────────────────────────────────────
  let dynToken;
  if (toWrite.length > 0) {
    try {
      dynToken = await getDynamicsToken();
    } catch (e) {
      logger.error({ err: e.message }, '[engagement/runner] Dynamics auth failed');
      throw e;
    }
  }

  for (const activity of toWrite) {
    const email = emailByLead.get(activity.leadId);
    if (!email) {
      summary.unmatched += 1;
      await insertDedupIfReal({
        marketoActivityId: activity.id,
        activityTypeId:    activity.activityTypeId,
        marketoLeadId:     activity.leadId,
        assetName:         activity.primaryAttributeValue,
        url:               getUrlAttr(activity),
        filterDecision:    'unmatched',
        filterReason:      'no email returned by Marketo for leadId',
        occurredAt:        activity.activityDate,
      });
      pushSample(activity, 'unmatched', { reason: 'no email for leadId' });
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     dryRun ? 'preview' : 'skipped',
        payload:    activity,
        email:      null,
        entityType: 'engagement',
        reason:     'no email for leadId',
      });
      continue;
    }

    let contactId = null;
    try {
      const resolved = await resolveAction(email, 'dynamics', dynToken);
      contactId = resolved.targetId;
    } catch (e) {
      // Lookup failure shouldn't kill the whole run — record + emit + move on
      summary.unmatched += 1;
      await insertDedupIfReal({
        marketoActivityId: activity.id,
        activityTypeId:    activity.activityTypeId,
        marketoLeadId:     activity.leadId,
        assetName:         activity.primaryAttributeValue,
        url:               getUrlAttr(activity),
        filterDecision:    'unmatched',
        filterReason:      `dynamics lookup failed: ${e.message}`,
        occurredAt:        activity.activityDate,
      });
      pushSample(activity, 'unmatched', { email, reason: `dynamics lookup failed: ${e.message}` });
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     dryRun ? 'preview' : 'failed',
        payload:    activity,
        email,
        entityType: 'engagement',
        error:      e.message,
      });
      continue;
    }

    if (!contactId) {
      summary.unmatched += 1;
      await insertDedupIfReal({
        marketoActivityId: activity.id,
        activityTypeId:    activity.activityTypeId,
        marketoLeadId:     activity.leadId,
        assetName:         activity.primaryAttributeValue,
        url:               getUrlAttr(activity),
        filterDecision:    'unmatched',
        filterReason:      `no Dynamics contact for ${email}`,
        occurredAt:        activity.activityDate,
      });
      pushSample(activity, 'unmatched', { email, reason: `no Dynamics contact for ${email}` });
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     dryRun ? 'preview' : 'skipped',
        payload:    activity,
        email,
        entityType: 'engagement',
        reason:     'no matching Dynamics contact',
      });
      continue;
    }

    // ── DRY RUN gate ────────────────────────────────────────────────────
    // Resolved a contact + activity passed all filters → this would be a
    // real write. Record the sample, emit a 'preview' event, and DO NOT
    // call writer.writeEngagementActivity or insertDedup('written').
    if (dryRun) {
      pushSample(activity, 'would-write', { email });
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     'preview',
        payload:    activity,
        email,
        entityType: 'engagement',
      });
      continue;
    }

    try {
      const { activityId } = await writer.writeEngagementActivity({ activity, contactId, token: dynToken });
      summary.written += 1;
      await safeInsertDedup({
        marketoActivityId:         activity.id,
        activityTypeId:            activity.activityTypeId,
        marketoLeadId:             activity.leadId,
        assetName:                 activity.primaryAttributeValue,
        url:                       getUrlAttr(activity),
        dynamicsContactId:         contactId,
        dynamicsEngagementActivityId: activityId,
        filterDecision:            'written',
        filterReason:              activity.activityTypeId === 14
          ? `status:${getStatusAttr(activity)}`
          : null,
        occurredAt:                activity.activityDate,
      });
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     'success',
        payload:    activity,
        email,
        entityType: 'engagement',
      });
    } catch (e) {
      summary.failed += 1;
      logger.error({ activityId: activity.id, err: e.message }, '[engagement/runner] writeEngagementActivity failed');
      // We deliberately do NOT insert a dedup row on write failure — leaving
      // the activity_id absent allows the next run to retry it.
      safeEmit({
        id:         String(activity.id),
        source:     'marketo',
        target:     'dynamics',
        status:     'failed',
        payload:    activity,
        email,
        entityType: 'engagement',
        error:      e.message,
      });
    }
  }

  // ── 6. Persist cursor + last-run summary ─────────────────────────────────
  // In dry-run we DO NOT advance the cursor — the next real cycle should
  // re-fetch the same window. We also skip persistLastRun so the audit
  // record of the last *real* cycle isn't clobbered by a preview.
  if (!dryRun) {
    await cursor.setCursor(token);
    await persistLastRun(summary);
  }
  summary.durationMs = Date.now() - startedAt;
  if (dryRun) summary.samples = samples;

  logger.info(
    {
      fetched: summary.fetched, written: summary.written,
      skipped: summary.skipped, unmatched: summary.unmatched,
      failed:  summary.failed,  durationMs: summary.durationMs,
    },
    '[engagement/runner] cycle complete',
  );

  return summary;
}

function getUrlAttr(activity) {
  const attrs = Array.isArray(activity?.attributes) ? activity.attributes : [];
  const link  = attrs.find(a => a?.name === 'Link');
  if (link) return link.value;
  const page  = attrs.find(a => a?.name === 'Webpage URL');
  if (page) return page.value;
  return null;
}

function getStatusAttr(activity) {
  const attrs = Array.isArray(activity?.attributes) ? activity.attributes : [];
  const s = attrs.find(a => a?.name === 'New Status') ||
            attrs.find(a => a?.name === 'Success')    ||
            attrs.find(a => a?.name === 'Reason');
  return s ? s.value : '';
}

/** Insert a dedup row. Swallow errors so one bad write can't kill the cycle. */
async function safeInsertDedup(row) {
  try {
    await dedupDb.insertDedup(row);
  } catch (e) {
    logger.warn({ err: e.message, activityId: row.marketoActivityId }, '[engagement/runner] dedup insert failed');
  }
}

async function persistLastRun(summary, errorMsg = null) {
  const blob = JSON.stringify({
    at:         new Date().toISOString(),
    durationMs: summary.durationMs,
    fetched:    summary.fetched,
    filtered:   summary.skipped,   // doc names skipped+unmatched as "filtered"
    written:    summary.written,
    unmatched:  summary.unmatched,
    failed:     summary.failed,
    error:      errorMsg,
  });
  try {
    await setConfig(KEY_LAST_RUN, blob, false);
  } catch (e) {
    logger.warn({ err: e.message }, '[engagement/runner] persistLastRun failed');
  }
}

module.exports = {
  runOnce,
  ACTIVITY_TYPE_IDS,
  MAX_ACTIVITIES_PER_RUN,
  DRY_RUN_SAMPLE_CAP,
  KEY_LAST_RUN,
  _getUrlAttr: getUrlAttr,
  _getStatusAttr: getStatusAttr,
};
