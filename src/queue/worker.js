'use strict';

const { shouldSkip }                    = require('../engine/loopGuard');
const { getSyncDirection, shouldSkipByDirection } = require('../engine/syncDirection');
const { resolveAction, resolveAccountAction } = require('../engine/dedup');
const { mapToMarketo }                  = require('../engine/fieldMapper');
const { enrichDerived }                 = require('../engine/derivedFields');
const { writeToMarketo, writeMarketoCompany }   = require('../writers/marketo');
const { stampMarketoIdOnContact }       = require('../writers/dynamics');
const { logEvent, logSkip }             = require('../audit/db');
const { getDynamicsToken }              = require('../auth/dynamics');
const { getMarketoToken }               = require('../auth/marketo');
const { emitSync }                      = require('../events/bus');
const logger                            = require('../audit/logger');
const { QUEUE_NAME, getBoss, startBoss } = require('./queue');
const { INTENT }                        = require('../engine/intent');
const { classifyMarketoIntent }         = require('../engine/marketoAuthority');
const { handleGlobalUnsubscribe }       = require('../engine/handlers/unsubscribe');
const { handleNewLead }                 = require('../engine/handlers/newLead');
const { checkConnectionRoles }          = require('../engine/relationships');
const { hasMappedChange }               = require('../engine/fieldDelta');
const { upsertSnapshot }                = require('../audit/db');
const { startAuthorityAlertScheduler }  = require('../monitor/authorityAlerts');

const CONCURRENCY = parseInt(process.env.SYNC_CONCURRENCY || '5', 10);

/**
 * Sync a single D365 account to Marketo. Shared by the standalone account
 * pipeline and the associated-data pre-sync.
 *
 * Post-Task-9 the only legal direction for this helper is Dynamics→Marketo;
 * Marketo-sourced account jobs are skipped by the authority router before
 * they can reach here.
 */
async function syncAccount(_source, _targetSystem, token, accountPayload) {
  const entityType = 'account';
  const key = accountPayload.name || accountPayload.company;
  if (!key) throw new Error('[worker] Account payload missing name/company');

  const { targetId } = await resolveAccountAction(key, 'marketo', token);
  const mapped       = mapToMarketo(accountPayload, entityType);
  const result       = await writeMarketoCompany(mapped, token);

  return { targetId: result.targetId || targetId };
}

/**
 * Core pipeline executed for every dequeued sync job.
 *
 * Accepts either a native pg-boss job envelope ({ id, data }) or a synthetic
 * job object used by tests. Existing test suites still call this directly
 * with a hand-rolled job — that contract is preserved.
 *
 * @param {{ id: string, data: object }} job
 */
async function processJob(job) {
  const { source, payload } = job.data;
  const targetSystem = source === 'dynamics' ? 'marketo' : 'dynamics';
  const entityType   = payload?.type === 'account' ? 'account'
                     : payload?.type === 'lead'    ? 'lead'
                     : 'contact';

  // ── Step 1: Loop guard ─────────────────────────────────────────────────────
  const direction = await getSyncDirection();
  const dirCheck  = shouldSkipByDirection(source, direction);
  const lg        = dirCheck.skip ? dirCheck : shouldSkip(job.data, targetSystem);
  const { skip, reason } = lg;
  if (skip) {
    logger.info({ jobId: job.id, reason }, '[worker] Job skipped by loop guard');
    await logEvent({
      source_system: source,
      source_id:     String(payload?.id || payload?.contactid || payload?.accountid || job.id),
      source_type:   entityType,
      target_system: targetSystem,
      payload:       payload || {},
      status:        'skipped',
      job_id:        String(job.id),
    });
    emitSync({
      id:      String(job.id),
      source,
      target:  targetSystem,
      status:  'skipped',
      payload: payload || {},
      email:   payload?.email || payload?.emailaddress1 || null,
      entityType,
      reason,
    });
    return { skipped: true, reason };
  }

  // ── Step 2: Acquire token for target ──────────────────────────────────────
  const token = targetSystem === 'marketo'
    ? await getMarketoToken()
    : await getDynamicsToken();

  // ── Step 2a: Marketo-source authority router ──────────────────────────────
  // Per spec §Operational Behaviour, Marketo may only write to CRM for
  // (a) global unsubscribe on Contacts, (b) new Lead creation. Everything
  // else from a Marketo source is unauthorized and must be skipped with a
  // structured reason. The generic pipeline below is Dynamics-source only.
  if (source === 'marketo') {
    const { intent, reason } = classifyMarketoIntent(payload);
    const sourceId = String(
      payload?.id || payload?.contactid || payload?.leadId || job.id,
    );

    if (intent === INTENT.GLOBAL_UNSUBSCRIBE) {
      const result = await handleGlobalUnsubscribe({ payload, token, job });
      if (result.status === 'success') {
        await logEvent({
          source_system: source,
          source_id:     sourceId,
          source_type:   'contact',
          target_system: targetSystem,
          target_id:     result.targetId,
          payload:       payload || {},
          status:        'success',
          job_id:        String(job.id),
        });
      } else {
        await logSkip({
          job, source, target: targetSystem,
          sourceType: 'contact',
          sourceId,
          payload:    payload || {},
          reason:     result.reason,
          category:   'authority',
          criterion:  'global-unsubscribe',
        });
      }
      emitSync({
        id:         String(job.id),
        source,
        target:     targetSystem,
        status:     result.status === 'success' ? 'success' : 'skipped',
        payload:    payload || {},
        email:      payload?.email || null,
        entityType: 'contact',
        reason:     result.reason,
      });
      return result.status === 'success'
        ? { targetId: result.targetId, action: 'update' }
        : { skipped: true, reason: result.reason };
    }

    if (intent === INTENT.NEW_LEAD) {
      const result = await handleNewLead({ payload, token, job });
      if (result.status === 'success') {
        await logEvent({
          source_system: source,
          source_id:     sourceId,
          source_type:   'lead',
          target_system: targetSystem,
          target_id:     result.targetId,
          payload:       payload || {},
          status:        'success',
          job_id:        String(job.id),
        });
      } else {
        // Eligibility-driven skips can carry multiple criteria; stuff the
        // composite reason in reason_criterion for operator filtering.
        const category  = result.reason?.startsWith('ineligible:') ? 'eligibility' : 'authority';
        const criterion = result.reason?.startsWith('ineligible:')
          ? result.reason.slice('ineligible:'.length)
          : result.reason;
        await logSkip({
          job, source, target: targetSystem,
          sourceType: 'lead',
          sourceId,
          payload:    payload || {},
          reason:     result.reason,
          category,
          criterion,
        });
      }
      emitSync({
        id:         String(job.id),
        source,
        target:     targetSystem,
        status:     result.status === 'success' ? 'success' : 'skipped',
        payload:    payload || {},
        email:      payload?.email || null,
        entityType: 'lead',
        reason:     result.reason,
      });
      return result.status === 'success'
        ? { targetId: result.targetId, action: 'create' }
        : { skipped: true, reason: result.reason };
    }

    // UNAUTHORIZED — skip with structured reason, never call writers.
    logger.info({ jobId: job.id, reason }, '[worker] Marketo-source payload unauthorized — skipping');
    await logSkip({
      job, source, target: targetSystem,
      sourceType: entityType,
      sourceId,
      payload:    payload || {},
      reason,
      category:   'authority',
      criterion:  reason,
    });
    emitSync({
      id:         String(job.id),
      source,
      target:     targetSystem,
      status:     'skipped',
      payload:    payload || {},
      email:      payload?.email || null,
      entityType,
      reason,
    });
    return { skipped: true, reason };
  }

  // ── Step 2b: Associated-data pre-sync ─────────────────────────────────────
  let associatedAccountTargetId = null;
  if (entityType !== 'account' && payload._associatedAccount) {
    try {
      const res = await syncAccount(source, targetSystem, token, payload._associatedAccount);
      associatedAccountTargetId = res.targetId;

      await logEvent({
        source_system: source,
        source_id:     String(payload._associatedAccount.accountid || `${job.id}-assoc`),
        source_type:   'account',
        target_system: targetSystem,
        target_id:     associatedAccountTargetId,
        payload:       payload._associatedAccount,
        status:        'success',
        job_id:        String(job.id),
      });
      emitSync({
        id:         `${job.id}-assoc`,
        source,
        target:     targetSystem,
        status:     'success',
        payload:    payload._associatedAccount,
        email:      null,
        entityType: 'account',
      });
    } catch (err) {
      logger.error({ jobId: job.id, error: err.message }, '[worker] Associated account sync failed — continuing with primary record');
    }
  }

  // Post-Task-9 invariant: `source` is always 'dynamics' from here on — the
  // Marketo-source router above returns for every possible classification.
  // targetSystem is therefore always 'marketo'; `writeToDynamics` + the
  // reverse mapper are no longer reachable and have been removed.

  // ── Step 2c: Mapped-field-change gate (Task 16) ──────────────────────────
  // Propagate only when a field declared in fieldmap.crmToMarketo actually
  // changed. Uses PreImage when the D365 webhook supplies _pre/_post,
  // otherwise loads the last stored snapshot from sync_snapshots. First
  // sighting of a record bypasses the gate (bootstrap).
  {
    const delta = await hasMappedChange(payload, entityType);
    if (!delta.changed) {
      logger.debug(
        { jobId: job.id, baseline: delta.baseline, reason: delta.reason },
        '[worker] No mapped-field change — skipping CRM→Marketo sync',
      );
      const sourceId = String(
        payload.contactid || payload.leadid || payload.accountid || payload.id || job.id,
      );
      await logSkip({
        job, source, target: targetSystem,
        sourceType: entityType,
        sourceId,
        payload:    payload || {},
        reason:     delta.reason,
        category:   'no-change',
        criterion:  delta.baseline,
      });
      // Intentionally no emitSync here — no-change skips are dedupe noise and
      // are excluded from the Logs feed (see /api/events WHERE clause). The DB
      // record above is still available via /api/events/by-source and the
      // /api/events/skipped aggregate.
      return { skipped: true, reason: delta.reason };
    }
  }

  // ── Step 3: Account pipeline (short-circuits here) ────────────────────────
  if (entityType === 'account') {
    const { targetId } = await resolveAccountAction(
      payload.name || payload.company,
      'marketo',
      token,
    );
    const mapped      = mapToMarketo(payload, 'account');
    const writeResult = await writeMarketoCompany(mapped, token);

    await logEvent({
      source_system: source,
      source_id:     String(payload.id || payload.accountid || job.id),
      source_type:   'account',
      target_system: targetSystem,
      target_id:     writeResult.targetId || targetId,
      payload,
      status:        'success',
      job_id:        String(job.id),
    });
    emitSync({
      id:         String(job.id),
      source,
      target:     targetSystem,
      status:     'success',
      payload,
      email:      null,
      entityType: 'account',
    });
    logger.info({ jobId: job.id, targetSystem }, '[worker] Account sync completed');
    return writeResult;
  }

  // ── Step 4: Contact/Lead pipeline (CRM → Marketo only) ───────────────────
  const email = payload.email || payload.emailaddress1;
  if (!email) throw new Error(`[worker] No email field found in payload for job ${job.id}`);

  await resolveAction(email, 'marketo', token); // dedup-by-email (sets action/targetId server-side in Marketo push)

  const mappedData = mapToMarketo(payload, entityType);
  await enrichDerived(mappedData, payload, entityType, token);

  const warnings = [];
  const writeResult = await writeToMarketo(mappedData, token);

  // Task 14 — on successful CRM→Marketo Contact write, stamp the returned
  // Marketo id back onto the Dynamics Contact for future correlation. Skip
  // if the Contact already carries a ubt_marketoid (idempotent).
  if (
    entityType === 'contact'
    && writeResult?.targetId
    && payload.contactid
    && !payload.ubt_marketoid
  ) {
    try {
      const dynToken = await getDynamicsToken();
      await stampMarketoIdOnContact({
        contactId: payload.contactid,
        marketoId: writeResult.targetId,
        token:     dynToken,
      });
      logger.info({
        jobId:     job.id,
        contactId: payload.contactid,
        marketoId: writeResult.targetId,
      }, '[worker] stamped ubt_marketoid on Dynamics contact');
    } catch (err) {
      warnings.push(`ubt_marketoid backfill failed: ${err.message}`);
      logger.warn({ jobId: job.id, err: err.message },
        '[worker] ubt_marketoid backfill failed — non-fatal');
    }
  }

  await logEvent({
    source_system: source,
    source_id:     String(payload.id || payload.contactid || payload.leadId || job.id),
    source_type:   entityType,
    target_system: targetSystem,
    target_id:     writeResult?.targetId || null,
    payload,
    status:        'success',
    error_message: warnings.length ? warnings.join('; ') : null,
    job_id:        String(job.id),
  });

  emitSync({
    id:         String(job.id),
    source,
    target:     targetSystem,
    status:     'success',
    payload,
    email,
    entityType,
    warnings:   warnings.length ? warnings : undefined,
  });

  // Task 16 — record the latest-known state so future delta checks have a
  // baseline even when the D365 webhook doesn't supply PreImage.
  const snapSourceId =
    payload.contactid || payload.leadid || payload.accountid || payload.id;
  if (snapSourceId) {
    try {
      await upsertSnapshot({
        source_system: source,
        source_id:     snapSourceId,
        source_type:   entityType,
        payload,
      });
    } catch (err) {
      logger.warn({ jobId: job.id, err: err.message },
        '[worker] sync_snapshots upsert failed — delta will bootstrap next time');
    }
  }

  logger.info({ jobId: job.id, targetSystem, entityType, warnings: warnings.length },
    '[worker] Job completed');
  return writeResult;
}

/**
 * Subscribe the worker to the pg-boss queue.
 * @returns {Promise<object>} The worker handle (stubbed to keep API compat
 *                            with the old BullMQ Worker — exposes close()
 *                            and on() as no-ops where needed).
 */
async function startWorkers() {
  await startBoss();
  const boss = getBoss();

  // Task 19 — authority-skip rate alerts. Opt-in via ENABLE_ALERTS=true so
  // local/test runs don't spin up timers. Fire-and-forget — the scheduler
  // swallows its own errors.
  if (process.env.ENABLE_ALERTS === 'true') {
    try {
      startAuthorityAlertScheduler();
    } catch (err) {
      logger.error({ err: err.message }, '[worker] failed to start authority-alert scheduler');
    }
  }

  // Task 17 — fire-and-forget connection-role boot check. Never blocks
  // startup; ASSUMPTIONS §3 requires a visible WARN when any of the six
  // expected roles are missing so operators can seed without redeploy.
  if (process.env.NODE_ENV !== 'test') {
    (async () => {
      try {
        const token = await getDynamicsToken();
        await checkConnectionRoles(token);
      } catch (err) {
        logger.info({ err: err.message }, '[worker] skipping connection-role boot check (no Dynamics token)');
      }
    })();
  }

  // pg-boss v9: subscribe(queueName, options, handler). teamSize controls
  // parallel job execution (equivalent to BullMQ's `concurrency`).
  await boss.work(QUEUE_NAME, { teamSize: CONCURRENCY, teamConcurrency: 1 }, async (job) => {
    try {
      const result = await processJob(job);
      logger.info({ jobId: job.id }, '[worker] completed');
      return result;
    } catch (err) {
      logger.error({ jobId: job?.id, error: err.message }, '[worker] failed');

      // Mirror the transient failure into the audit trail so the dashboard
      // shows that processing is actually happening (and why it is failing).
      const payload = job?.data?.payload;
      const source  = job?.data?.source || 'unknown';
      try {
        await logEvent({
          source_system: source,
          source_id:     String(payload?.id || payload?.contactid || payload?.leadid || payload?.accountid || job?.id),
          source_type:   payload?.type || 'unknown',
          target_system: source === 'dynamics' ? 'marketo' : 'dynamics',
          payload:       payload || {},
          status:        'failed',
          error_message: err.message,
          job_id:        String(job?.id),
        });
      } catch (dbErr) {
        logger.error({ error: dbErr.message }, '[worker] Failed to log failure to audit table');
      }

      throw err; // let pg-boss count the attempt + retry/dead-letter
    }
  });

  return {
    async close() { /* caller uses stopBoss() in the shutdown path */ },
    on() { /* compat shim for any old listener hooks */ },
  };
}

module.exports = { processJob, startWorkers };
