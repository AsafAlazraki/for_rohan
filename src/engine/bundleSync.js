'use strict';

/**
 * Manual "Sync with Company" bundle helper.
 *
 * Operator-triggered, multi-row sequential push from Dynamics → Marketo. For
 * each selected Contact or Lead:
 *   - read full Dynamics record by id
 *   - resolve associated Account (Contact: parentcustomerid; Lead:
 *     accountnumber → name via accountResolver)
 *   - if there is company info but it does NOT resolve to a real CRM Account,
 *     skip the row (data-quality enforcement)
 *   - if there is no company info at all, push the Person only
 *   - otherwise push Account → Marketo first, then Person → Marketo
 *
 * If the Account write fails mid-row, the Person write is still attempted
 * (Marketo will auto-create the Company under its own dedup). Each leg
 * (Account / Person) gets its own audit row tagged with reason_category=
 * 'manual' and reason_criterion='manual:sync-with-company'.
 *
 * Both `previewBundle` and `runBundle` are sequential — never throw at the
 * top level — and return a per-row result + aggregate summary.
 */

const { readDynamicsById }                  = require('../readers/dynamics');
const { resolveAccount }                    = require('./accountResolver');
const { mapToMarketoAsync }                 = require('./fieldMapper');
const { enrichDerived }                     = require('./derivedFields');
const { writeToMarketo, writeMarketoCompany } = require('../writers/marketo');
const { logEvent, logSkip }                 = require('../audit/db');
const { emitSync }                          = require('../events/bus');
const logger                                = require('../audit/logger');

const VALID_ENTITIES = Object.freeze(['contact', 'lead']);
const REASON_CRITERION = 'manual:sync-with-company';

function ensureValidEntity(entity) {
  if (!VALID_ENTITIES.includes(entity)) {
    throw new Error(`[bundleSync] entity must be one of: ${VALID_ENTITIES.join(', ')}`);
  }
}

/**
 * Decide what to do with a record's associated company.
 *
 * @returns {Promise<{
 *   plan:        'with-company' | 'person-only' | 'skip',
 *   skipReason?: string,
 *   accountId?:  string,
 *   accountRecord?: object,
 *   matchedBy?:  string,
 * }>}
 */
async function resolveAssociatedCompany({ record, entityType, dynToken }) {
  ensureValidEntity(entityType);

  if (entityType === 'contact') {
    const parentId = record._parentcustomerid_value;
    if (!parentId) return { plan: 'person-only' };
    const accountRecord = await readDynamicsById({ entity: 'account', id: parentId });
    if (!accountRecord) {
      // FK exists but the row is gone (deleted/inactive) — treat as data-quality skip.
      return { plan: 'skip', skipReason: 'no-resolvable-account' };
    }
    return { plan: 'with-company', accountId: parentId, accountRecord, matchedBy: 'parentcustomerid' };
  }

  // Lead
  const ids = {
    accountnumber: record.accountnumber,
    name:          record.companyname || record.company,
  };
  if (!ids.accountnumber && !ids.name) return { plan: 'person-only' };

  const { targetId, matchedBy } = await resolveAccount({ ids, token: dynToken });
  if (!targetId) return { plan: 'skip', skipReason: 'no-resolvable-account' };

  const accountRecord = await readDynamicsById({ entity: 'account', id: targetId });
  if (!accountRecord) return { plan: 'skip', skipReason: 'no-resolvable-account' };

  return { plan: 'with-company', accountId: targetId, accountRecord, matchedBy };
}

function summarize(rows) {
  return {
    total:        rows.length,
    withCompany:  rows.filter(r => r.plan === 'with-company').length,
    personOnly:   rows.filter(r => r.plan === 'person-only').length,
    willSkip:     rows.filter(r => r.plan === 'skip').length,
    errors:       rows.filter(r => r.plan === 'error').length,
  };
}

function summarizeRun(results) {
  return {
    total:           results.length,
    personsSynced:   results.filter(r => r.personSynced).length,
    accountsSynced:  results.filter(r => r.accountSynced).length,
    skipped:         results.filter(r => r.skipReason).length,
    failed:          results.filter(r => r.error && !r.personSynced).length,
  };
}

function identOf(record, entity, sourceId) {
  if (entity === 'contact' || entity === 'lead') {
    return record.emailaddress1
      || `${record.firstname || ''} ${record.lastname || ''}`.trim()
      || record.contactid
      || record.leadid
      || sourceId;
  }
  return record.name || record.company || sourceId;
}

/**
 * Read-only resolution + projection. No writes, no audit rows. Drives the
 * preview modal so the operator can see what WOULD be pushed.
 *
 * @param {{ entity: 'contact'|'lead', sourceIds: string[],
 *           dynToken: string, mktToken: string }} args
 */
async function previewBundle({ entity, sourceIds, dynToken, mktToken }) {
  ensureValidEntity(entity);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new Error('[bundleSync.previewBundle] sourceIds must be a non-empty array');
  }

  const rows = [];
  for (const sourceId of sourceIds) {
    try {
      const record = await readDynamicsById({ entity, id: sourceId });
      if (!record) {
        rows.push({
          sourceId,
          plan:       'skip',
          skipReason: 'source-record-not-found',
          identifier: sourceId,
        });
        continue;
      }

      const resolution = await resolveAssociatedCompany({ record, entityType: entity, dynToken });

      const personBody = await mapToMarketoAsync(record, entity, { token: mktToken });
      await enrichDerived(personBody, record, entity, mktToken);

      let accountBody = null;
      if (resolution.plan === 'with-company') {
        accountBody = await mapToMarketoAsync(resolution.accountRecord, 'account', { token: mktToken });
      }

      rows.push({
        sourceId,
        plan:       resolution.plan,
        skipReason: resolution.skipReason || null,
        accountId:  resolution.accountId || null,
        matchedBy:  resolution.matchedBy || null,
        accountBody,
        personBody,
        identifier: identOf(record, entity, sourceId),
      });
    } catch (err) {
      logger.warn({ sourceId, err: err.message }, '[bundleSync.previewBundle] row failed');
      rows.push({
        sourceId,
        plan:       'error',
        error:      err.message,
        identifier: sourceId,
      });
    }
  }

  return { summary: summarize(rows), rows };
}

/**
 * Live run. Sequential; never throws at the top level. Each row produces:
 *   - up to two audit rows (Account, then Person) tagged 'manual'
 *   - up to two SSE events on the same row's job-id family
 *
 * @param {{ entity: 'contact'|'lead', sourceIds: string[],
 *           dynToken: string, mktToken: string,
 *           jobIdPrefix?: string }} args
 */
async function runBundle({ entity, sourceIds, dynToken, mktToken, jobIdPrefix = `bundle-${Date.now()}` }) {
  ensureValidEntity(entity);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
    throw new Error('[bundleSync.runBundle] sourceIds must be a non-empty array');
  }

  const results = [];

  for (const sourceId of sourceIds) {
    const result = {
      sourceId,
      plan:            null,
      accountSynced:   false,
      personSynced:    false,
      accountTargetId: null,
      personTargetId:  null,
      skipReason:      null,
      error:           null,
      identifier:      sourceId,
    };

    let record;
    try {
      record = await readDynamicsById({ entity, id: sourceId });
    } catch (err) {
      result.error = `read-failed: ${err.message}`;
      results.push(result);
      logger.error({ sourceId, err: err.message }, '[bundleSync] read failed');
      continue;
    }

    if (!record) {
      result.plan       = 'skip';
      result.skipReason = 'source-record-not-found';
      await safeLogSkip({ entity, sourceId, payload: {}, reason: result.skipReason, jobId: `${jobIdPrefix}-${sourceId}` });
      results.push(result);
      continue;
    }

    result.identifier = identOf(record, entity, sourceId);

    let resolution;
    try {
      resolution = await resolveAssociatedCompany({ record, entityType: entity, dynToken });
    } catch (err) {
      result.error = `resolve-failed: ${err.message}`;
      results.push(result);
      logger.error({ sourceId, err: err.message }, '[bundleSync] resolve failed');
      continue;
    }
    result.plan = resolution.plan;

    // ── skip ──────────────────────────────────────────────────────────────
    if (resolution.plan === 'skip') {
      result.skipReason = resolution.skipReason;
      await safeLogSkip({
        entity, sourceId, payload: record,
        reason: resolution.skipReason,
        jobId: `${jobIdPrefix}-${sourceId}`,
      });
      try {
        emitSync({
          id:         `${jobIdPrefix}-${sourceId}`,
          source:     'dynamics',
          target:     'marketo',
          status:     'skipped',
          payload:    record,
          email:      record.emailaddress1 || null,
          entityType: entity,
          reason:     `${REASON_CRITERION}:${resolution.skipReason}`,
        });
      } catch { /* bus must never throw */ }
      results.push(result);
      continue;
    }

    // ── Account write (when company info resolved) ────────────────────────
    if (resolution.plan === 'with-company') {
      try {
        const accountBody = await mapToMarketoAsync(resolution.accountRecord, 'account', { token: mktToken });
        const writeRes    = await writeMarketoCompany(accountBody, mktToken);

        // Companies endpoint unavailable on this tenant — soft-skip, don't
        // mark the row as failed. Lead push carries `company` so Marketo
        // dedups the Company on the fly via lead-side linkage.
        if (writeRes.status === 'skipped' && writeRes.reason === 'companies-endpoint-unavailable') {
          await safeLogEvent({
            source_system: 'dynamics',
            source_id:     String(resolution.accountId),
            source_type:   'account',
            target_system: 'marketo',
            payload:       resolution.accountRecord,
            status:        'skipped',
            error_message: 'companies-endpoint-unavailable',
            reason_category: 'manual',
            reason_criterion: `${REASON_CRITERION}:companies-endpoint-unavailable`,
            job_id:        `${jobIdPrefix}-${sourceId}-account`,
          });
        } else {
          result.accountSynced   = true;
          result.accountTargetId = writeRes.targetId;

          await safeLogEvent({
            source_system: 'dynamics',
            source_id:     String(resolution.accountId),
            source_type:   'account',
            target_system: 'marketo',
            target_id:     writeRes.targetId,
            payload:       resolution.accountRecord,
            status:        'success',
            reason_category: 'manual',
            reason_criterion: REASON_CRITERION,
            job_id:        `${jobIdPrefix}-${sourceId}-account`,
          });
          try {
            emitSync({
              id:         `${jobIdPrefix}-${sourceId}-account`,
              source:     'dynamics',
              target:     'marketo',
              status:     'success',
              payload:    resolution.accountRecord,
              email:      null,
              entityType: 'account',
            });
          } catch { /* bus must never throw */ }
        }
      } catch (accountErr) {
        // Per the design: account failure must not block the person push.
        // Marketo will auto-create the Company on the fly via lead.company.
        result.error = `account-write-failed: ${accountErr.message}`;
        logger.warn({ sourceId, err: accountErr.message },
          '[bundleSync] account write failed — proceeding with person');
        await safeLogEvent({
          source_system: 'dynamics',
          source_id:     String(resolution.accountId),
          source_type:   'account',
          target_system: 'marketo',
          payload:       resolution.accountRecord,
          status:        'failed',
          error_message: accountErr.message,
          reason_category: 'manual',
          reason_criterion: REASON_CRITERION,
          job_id:        `${jobIdPrefix}-${sourceId}-account`,
        });
      }
    }

    // ── Person write (always attempted unless skipped above) ──────────────
    try {
      const personBody = await mapToMarketoAsync(record, entity, { token: mktToken });
      await enrichDerived(personBody, record, entity, mktToken);
      const writeRes = await writeToMarketo(personBody, mktToken);
      result.personSynced   = true;
      result.personTargetId = writeRes.targetId;

      await safeLogEvent({
        source_system: 'dynamics',
        source_id:     String(sourceId),
        source_type:   entity,
        target_system: 'marketo',
        target_id:     writeRes.targetId,
        payload:       record,
        status:        'success',
        reason_category: 'manual',
        reason_criterion: REASON_CRITERION,
        job_id:        `${jobIdPrefix}-${sourceId}`,
      });
      try {
        emitSync({
          id:         `${jobIdPrefix}-${sourceId}`,
          source:     'dynamics',
          target:     'marketo',
          status:     'success',
          payload:    record,
          email:      record.emailaddress1 || null,
          entityType: entity,
        });
      } catch { /* bus must never throw */ }
    } catch (personErr) {
      const msg = `person-write-failed: ${personErr.message}`;
      result.error = result.error ? `${result.error}; ${msg}` : msg;
      logger.error({ sourceId, err: personErr.message }, '[bundleSync] person write failed');
      await safeLogEvent({
        source_system: 'dynamics',
        source_id:     String(sourceId),
        source_type:   entity,
        target_system: 'marketo',
        payload:       record,
        status:        'failed',
        error_message: personErr.message,
        reason_category: 'manual',
        reason_criterion: REASON_CRITERION,
        job_id:        `${jobIdPrefix}-${sourceId}`,
      });
      try {
        emitSync({
          id:         `${jobIdPrefix}-${sourceId}`,
          source:     'dynamics',
          target:     'marketo',
          status:     'failed',
          payload:    record,
          email:      record.emailaddress1 || null,
          entityType: entity,
          error:      personErr.message,
        });
      } catch { /* bus must never throw */ }
    }

    results.push(result);
  }

  return { summary: summarizeRun(results), results, jobIdPrefix };
}

// ── audit helpers — never throw, never block the loop ─────────────────────
async function safeLogEvent(args) {
  try { return await logEvent(args); }
  catch (err) { logger.warn({ err: err.message }, '[bundleSync] logEvent failed'); }
}

async function safeLogSkip({ entity, sourceId, payload, reason, jobId }) {
  try {
    return await logSkip({
      job:        { id: jobId },
      source:     'dynamics',
      target:     'marketo',
      sourceType: entity,
      sourceId:   String(sourceId),
      payload,
      reason:     `${REASON_CRITERION}:${reason}`,
      category:   'manual',
      criterion:  `${REASON_CRITERION}:${reason}`,
    });
  } catch (err) {
    logger.warn({ err: err.message }, '[bundleSync] logSkip failed');
  }
}

module.exports = {
  previewBundle,
  runBundle,
  resolveAssociatedCompany,
  REASON_CRITERION,
  VALID_ENTITIES,
};
