'use strict';

const { logEvent } = require('../audit/db');
const logger       = require('../audit/logger');
const { emitSync } = require('../events/bus');
const { getBoss, startBoss, enqueue, QUEUE_NAME } = require('./queue');

/**
 * pg-boss moves a job to state='failed' once it exhausts retryLimit. This
 * module hooks that lifecycle and mirrors the failure into our sync_events
 * audit table + the live dashboard.
 */

async function captureFailed(job, err) {
  const source = job?.data?.source || 'unknown';
  try {
    await logEvent({
      source_system:  source,
      source_id:      String(job?.data?.payload?.id || job?.id),
      source_type:    job?.data?.payload?.type || 'unknown',
      target_system:  source === 'dynamics' ? 'marketo' : 'dynamics',
      payload:        job?.data?.payload || {},
      status:         'failed',
      error_message:  err?.message || 'Unknown error',
      error_detail:   { stack: err?.stack, state: 'pgboss:failed' },
      job_id:         String(job?.id),
    });
    logger.warn({ jobId: job?.id, error: err?.message }, '[dlq] Job captured to DLQ');
  } catch (dbErr) {
    logger.error({ error: dbErr.message, jobId: job?.id }, '[dlq] Failed to persist DLQ event');
  }

  try {
    emitSync({
      id:      String(job?.id),
      source,
      target:  source === 'dynamics' ? 'marketo' : 'dynamics',
      status:  'failed',
      payload: job?.data?.payload || {},
      email:   job?.data?.payload?.email || job?.data?.payload?.emailaddress1 || null,
      error:   err?.message,
    });
  } catch { /* bus should never throw, but be safe */ }
}

/**
 * Re-enqueue a job that previously failed. Produces a fresh job with a new
 * retry counter; the original remains in the pgboss.archive table for
 * forensics.
 */
async function replayDLQ(originalJobId) {
  await startBoss();
  const boss = getBoss();

  // pg-boss stores job data in the jobs table; look it up via the admin API
  const job = await boss.getJobById(originalJobId).catch(() => null);
  if (!job) throw new Error(`[dlq] Job not found in pg-boss: ${originalJobId}`);

  const newId = await enqueue(QUEUE_NAME, job.data);
  logger.info({ originalJobId, newJobId: newId }, '[dlq] Job replayed');
  return { id: newId };
}

/**
 * Count of jobs in the 'failed' state for our queue.
 */
async function getDLQDepth() {
  await startBoss();
  const boss = getBoss();
  // pg-boss exposes per-state counts via getQueueSize(name, options)
  return boss.getQueueSize(QUEUE_NAME, { state: 'failed' });
}

/**
 * Wire the DLQ capture into the worker lifecycle.
 *
 * pg-boss v9 exposes onComplete(queueName, handler) — the handler fires
 * for every completed job with its terminal state embedded in the
 * response payload. Jobs that exhausted retries arrive with state='failed'.
 */
async function attachDLQListener() {
  await startBoss();
  const boss = getBoss();
  await boss.onComplete(QUEUE_NAME, async (job) => {
    const response = job?.data?.response || {};
    const state    = job?.data?.state;
    if (state !== 'failed' && response?.state !== 'failed') return;

    const err = response?.message
      ? new Error(response.message)
      : new Error('Job failed after all retries');
    // Reconstruct original job shape for the capture helper.
    const originalJob = {
      id:   job?.data?.request?.id   || job?.id,
      data: job?.data?.request?.data || {},
    };
    await captureFailed(originalJob, err);
  }).catch((e) => {
    logger.warn(
      { error: e.message },
      '[dlq] Could not subscribe to onComplete; DLQ rows will only appear via direct logEvent calls',
    );
  });
}

module.exports = { captureFailed, replayDLQ, getDLQDepth, attachDLQListener };
